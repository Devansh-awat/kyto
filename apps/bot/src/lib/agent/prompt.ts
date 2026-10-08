import { mrkdwnToMarkdown } from '@/harness/markdown';
import type { ThreadHandle as Thread } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { compactOverflow, loadThreadSummary } from '@/lib/agent/compaction';
import {
  renderUnreadableBlock,
  replayWindowStart,
} from '@/lib/agent/compaction-plan';
import { isFocusAllowed } from '@/lib/agent/focus';
import { annotateMentions } from '@/lib/agent/mentions';
import { recallThinking, renderThinking } from '@/lib/agent/thinking';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { renderNotebooks } from '@/lib/notebooks';
import { isHiddenFromBot, rawSlackText } from '@/lib/utils/message';

// We never persist a session, so the whole Slack thread is the agent's only
// memory. Cap how many prior messages we replay VERBATIM to bound prompt size.
const MAX_THREAD_MESSAGES = 100;
// …and at most this much text (~60k tokens), so a thread of pasted logs does not
// replay hundreds of thousands of characters on every turn. What falls out goes
// to the digest. Moved in steps so the window's start — where the replayed,
// cached history begins — shifts rarely (see replayWindowStart).
const MAX_REPLAY_CHARS = 240_000;
const REPLAY_STEP = 25;
// How far back we look beyond that cap. Everything between this and the verbatim
// window is compacted into a summary (see lib/agent/compaction) instead of being
// dropped on the floor, which is what used to happen: the model was handed the
// tail of a conversation with no indication it had a beginning, and cheerfully
// contradicted decisions made earlier in the same thread.
//
// The whole thread, up to a ceiling. It used to be 400 — four times the replay
// window — which meant a 1,500-message thread had ~1,100 messages that were not
// summarized and not counted, just absent. They are only read ONCE: after the
// first pass the read starts at the last digested message (`oldest` below), so
// the steady-state cost is the replay window, not the thread.
const MAX_HISTORY_MESSAGES = 20_000;
// Slack can only page a thread forward, so reaching the newest message of a
// never-compacted thread costs one call per 1,000 messages. This bounds that
// first walk. Past it the fetch stops short of the end — logged, because the
// replay window would then not be the live conversation.
const MAX_HISTORY_PAGES = 20;
// How far back to re-anchor when even that budget does not reach the end of the
// thread. Short enough to always reach the newest message, long enough that the
// replay window is still full.
const RECENT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
// The bot's Slack username is a leftover gorkie-era handle; label its own
// authored messages as kyto so it doesn't think "gorkie" spoke (mirrors the
// same special-case in annotateMentions).
const BOT_NAME = 'kyto';

function readThread({
  asUserAccount,
  oldest,
  threadId,
}: {
  asUserAccount: boolean;
  oldest?: string;
  threadId: string;
}): Promise<{ messages: Message[]; nextCursor?: string } | undefined> {
  return slack
    .fetchMessages(threadId, {
      asUserAccount,
      limit: MAX_HISTORY_MESSAGES,
      maxPages: MAX_HISTORY_PAGES,
      ...(oldest ? { oldest } : {}),
    })
    .catch(() => undefined);
}

/** A Slack ts a week before the message being answered. */
function recentAnchor(messageId: string): string {
  const at = Number(messageId);
  const from = Number.isFinite(at) ? at : Date.now() / 1000;
  return (from - RECENT_WINDOW_SECONDS).toFixed(6);
}

function authorLabel(message: Message): string {
  if (slack.botUserId && message.author.userId === slack.botUserId) {
    return BOT_NAME;
  }
  if (slack.userAccountId && message.author.userId === slack.userAccountId) {
    return `${BOT_NAME} [your user account]`;
  }
  // Said outright so the model knows it is answering a program, not a person.
  return message.author.isBot === true
    ? `${message.author.userName} [bot]`
    : message.author.userName;
}

async function renderMessage(message: Message): Promise<string> {
  const slackText = rawSlackText(message);
  const text = slackText
    ? mrkdwnToMarkdown(await annotateMentions(slackText))
    : message.text;
  return `@${authorLabel(message)} (${message.author.userId}): ${text}`;
}

export async function buildPrompt(
  message: Message,
  {
    asUserAccount = false,
    codeChannel = false,
    customizationPrompt,
    includeHidden = false,
    ownModelsOnly = false,
    thread,
  }: {
    /** Answering as kyto's Slack user account; per turn, so volatile tail. */
    asUserAccount?: boolean;
    /** In a code channel (lib/code-channels). Per channel, so volatile tail. */
    codeChannel?: boolean;
    customizationPrompt?: string;
    /**
     * Kevinton's review: replay `##` messages too, marked as hidden. People
     * complain about kyto there precisely so it isn't interrupted, which is
     * what a review needs to read. Never for a turn that answers anyone.
     */
    includeHidden?: boolean;
    /** Runs only on the asker's own model key, where the no-coding rule lifts. */
    ownModelsOnly?: boolean;
    thread?: Thread;
  } = {}
): Promise<{ history: string[]; tail: string }> {
  const current = await renderMessage(message);

  // What kyto was THINKING on this thread's last few turns. Slack replayed above
  // only records what it said, so without this each turn re-derives the reasoning
  // (and the dead ends) of the one before it.
  const thinking = thread
    ? renderThinking(await recallThinking(thread.id))
    : '';

  // The user account reads the global notebook too; the app, only the
  // channel's (lib/notebooks.ts). A failed read costs the notes, not the turn.
  const notebooks = thread
    ? await renderNotebooks({
        channelId: slack.decodeThreadId(thread.id).channel,
        includeGlobal: asUserAccount,
      }).catch((error: unknown) => {
        logger.warn({ err: error }, '[prompt] could not load the notebooks');
        return '';
      })
    : '';

  let history: string[] = [];
  let compacted = '';
  let pulledInLater = false;
  if (thread) {
    // Focus mode: drop messages from non-focused users so kyto genuinely never
    // sees what other people said in a focused thread (not just declines to
    // reply). Its own messages and the owner's are always kept.
    const focusState = await thread.state.catch(() => null);
    // Start the read at the newest message an earlier turn already digested.
    // Everything before it is in the summary, so re-reading it would be Slack
    // API work whose only output we already have written down.
    const stored = await loadThreadSummary(thread.id);
    let fetched = await readThread({
      asUserAccount,
      oldest: stored?.throughMessageId,
      threadId: thread.id,
    });
    // A cursor left over means the walk ran out of budget BEFORE the end of the
    // thread — so what we hold is a middle slice, and replaying its last 100
    // messages would hand the model a conversation from months ago as if it
    // were live. A real thread hit this: 25,000+ messages. Re-anchor near now,
    // which always reaches the end, and give up on compaction for this turn
    // rather than fold a slice that does not join onto the stored digest.
    let contiguous = true;
    if (fetched?.nextCursor) {
      const recent = await readThread({
        asUserAccount,
        oldest: recentAnchor(message.id),
        threadId: thread.id,
      });
      logger.warn(
        { threadId: thread.id },
        '[prompt] thread is longer than the history ceiling; reading only recent messages'
      );
      if (recent) {
        fetched = recent;
        contiguous = false;
      }
    }
    const visible = (entry: Message) =>
      entry.id !== message.id &&
      isFocusAllowed(focusState, entry.author.userId, {
        isMe: entry.author.isMe === true,
      });
    const prior = (fetched?.messages ?? []).filter(
      (entry) => visible(entry) && !isHiddenFromBot(entry)
    );
    // A reply kyto wasn't pinged for, in a thread whose top didn't ping it
    // either: someone pulled it in partway, so most of what follows is people
    // talking to each other, and answering all of it was the complaint. Only
    // when the root was actually read — unknown means the old behaviour.
    const { threadTs } = slack.decodeThreadId(thread.id);
    const selfId = asUserAccount ? slack.userAccountId : slack.botUserId;
    const root = fetched?.messages.find((entry) => entry.id === threadTs);
    pulledInLater =
      !(
        includeHidden ||
        codeChannel ||
        message.isMention ||
        slack.isDM(thread.id)
      ) &&
      message.id !== threadTs &&
      root !== undefined &&
      selfId !== undefined &&
      root.author.userId !== selfId &&
      !(rawSlackText(root) ?? '').includes(`<@${selfId}>`);
    // Split AFTER filtering, so a focused thread's window is 100 messages kyto
    // may actually see rather than 100 slots partly spent on hidden ones.
    const start = replayWindowStart({
      maxChars: MAX_REPLAY_CHARS,
      maxMessages: MAX_THREAD_MESSAGES,
      sizes: prior.map((entry) => (rawSlackText(entry) || entry.text).length),
      step: REPLAY_STEP,
    });
    const overflow = prior.slice(0, start);
    // The `##` messages ride along only inside the replay window, never into
    // `overflow`: the digest it feeds is shared with every later turn, and a
    // hidden message folded into it would reach kyto after all.
    const firstReplayed = prior[start]?.id;
    const inWindow = new Set(prior.slice(start));
    const replayed = includeHidden
      ? (fetched?.messages ?? []).filter(
          (entry) =>
            visible(entry) &&
            (isHiddenFromBot(entry)
              ? overflow.length === 0 ||
                (firstReplayed !== undefined && entry.id >= firstReplayed)
              : inWindow.has(entry))
        )
      : prior.slice(start);
    if (!contiguous) {
      compacted = renderUnreadableBlock({
        summary: stored?.summary,
      });
    } else if (overflow.length > 0 || stored) {
      const rendered = await Promise.all(
        overflow.map(async (entry) => ({
          id: entry.id,
          rendered: await renderMessage(entry),
        }))
      );
      compacted = await compactOverflow({
        overflow: rendered,
        threadId: thread.id,
        ...(stored ? { stored } : {}),
      });
    }
    if (replayed.length > 0) {
      const rendered = await Promise.all(
        replayed.map(async (entry) =>
          isHiddenFromBot(entry)
            ? `[## — hidden from kyto's own turns] ${await renderMessage(entry)}`
            : renderMessage(entry)
        )
      );
      history = rendered.map((line, index) =>
        index === 0
          ? `Conversation so far in this Slack thread (oldest first):\n${line}`
          : line
      );
    }
  }

  // The label that introduces the new message. Kept with `current` rather than
  // appended to `history`, because the thinking block now sits BETWEEN them —
  // and a "the latest message is next" line followed by a page of last turn's
  // reasoning reads as if the reasoning were the message.
  const latest =
    history.length > 0
      ? `The latest message, which you must respond to:\n${current}`
      : current;

  // The two facts that change on EVERY turn, kept in the volatile tail rather
  // than in the system prompt where they used to be. A per-turn timestamp and a
  // per-turn message id inside the system string meant cache breakpoint A (the
  // system prompt + every tool schema) missed on every new turn of a thread —
  // the biggest single cached prefix, re-billed at full price each time, on a
  // shared daily cap. Down here they invalidate nothing but themselves.
  const nowLine = [
    `The current date and time is ${new Date().toISOString()}.`,
    `The message you're responding to has id ${message.id}.`,
    // Per person, so it lives down here with the clock: in the system prompt it
    // would split the cached prefix between key-holders and everyone else.
    ...(ownModelsOnly
      ? [
          "This turn runs on the person's OWN model key, not Hack Club AI's shared one, so the coding-agent rule does not apply to it.",
        ]
      : []),
    ...(asUserAccount
      ? [
          // The system prompt names the APP's id as "your own" — it is shared
          // with app turns for the cache — so without this line the persona
          // read a ping to its own id as one for "another kyto" and skipped.
          `In THIS turn you are kyto's user account, Slack id ${slack.userAccountId ?? 'unknown'}: a message mentioning <@${slack.userAccountId ?? 'unknown'}> is addressed to YOU, and the "your own Slack user id" line above (${slack.botUserId ?? 'unknown'}) is the kyto app, your other half, not you this turn.`,
          'You are answering as kyto\'s own Slack USER account — a regular member account named kyto, not the kyto app — so talk like a person in Slack does: short and casual, usually a line or two, no headings, no bullet lists unless the answer really is a list, no sign-offs or offers of more help. Nobody sees your plan, tool calls or reasoning, only what you write. On a longer task, one or two very short status lines before the answer are fine ("on it, give me a sec"); otherwise write only the answer. If the message isn\'t for you or needs no reply, call skip — nothing at all is shown. Your tools are the same as always.',
        ]
      : []),
    ...(pulledInLater
      ? [
          "This message doesn't mention you, and this thread didn't start with you — someone brought you in partway, so you're seeing every reply here, most of them people talking to each other. Decide whether this one needs you: reply only if it's addressed to you, follows up on something you said, or asks something you should clearly answer. Otherwise call skip — nothing is posted.",
        ]
      : []),
    ...(codeChannel
      ? [
          'This is a CODE CHANNEL: every top-level message here is for you without a mention, and every thread in the channel shares ONE sandbox workspace — files from earlier threads are already there, so check before starting over. Earlier threads are readable with the Slack history tools.',
        ]
      : []),
  ].join('\n');

  // ORDER IS LOAD-BEARING, for prompt caching (see addCacheControl in
  // packages/ai/src/cache-control.ts).
  //
  // `history` goes out as one user message PER ENTRY, ahead of the tail, with a
  // cache breakpoint on its last one. gpt-6-luna only looks a cache up at
  // message endings, so next turn that same ending is still there and the whole
  // thread up to it is a cached read. Joined into one message with the tail it
  // never was: the measured cross-turn read stopped at the system prompt.
  // Cheapest → most volatile, so the cacheable prefix is as long as possible:
  //
  //   user_instructions   changes only when the user edits them
  //   notebooks           changes when kevinton edits one — ~30 min after a
  //                       turn, by which time the 30-min cache has lapsed anyway
  //   compacted           changes once per COMPACT_BATCH of overflow
  //   history             append-only until the thread passes MAX_THREAD_MESSAGES
  //   --- tail (one message, rewritten every turn) ---
  //   thinking            CHANGES EVERY TURN (last turn's reasoning is appended)
  //   nowLine + current   the clock, the message id, and the new message
  //
  // The thinking block used to come FIRST, which invalidated the cached prefix
  // at byte ~0 and re-billed the entire replayed thread every turn.
  //
  // Do NOT move a volatile block above the tail, and never render a history
  // entry differently from one turn to the next.
  return {
    history: [
      customizationPrompt
        ? [
            '<user_instructions>',
            customizationPrompt,
            '</user_instructions>',
          ].join('\n')
        : '',
      notebooks,
      compacted,
      ...history,
    ].filter(Boolean),
    tail: [thinking, nowLine, latest].filter(Boolean).join('\n\n'),
  };
}
