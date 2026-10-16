import { getThreadPromptSize, type MessageRevision } from '@repo/db/queries';
import { mrkdwnToMarkdown } from '@/harness/markdown';
import type { ThreadHandle as Thread } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { compactOverflow, loadThreadSummary } from '@/lib/agent/compaction';
import { renderUnreadableBlock } from '@/lib/agent/compaction-plan';
import { isFocusAllowed } from '@/lib/agent/focus';
import { annotateMentions } from '@/lib/agent/mentions';
import { recallThinking, renderThinking } from '@/lib/agent/thinking';
import { slack } from '@/lib/chat';
import { parseFlags, withoutFlags } from '@/lib/flags';
import logger from '@/lib/logger';
import { threadRevisions } from '@/lib/message-revisions';
import { renderNotebooks } from '@/lib/notebooks';
import { mayReadChannel } from '@/lib/slack/channel-access';
import { renderLinkedCanvases } from '@/lib/slack/linked-canvases';
import {
  isHiddenFromBot,
  rawSlackText,
  rawText,
  withoutLeadingMentions,
} from '@/lib/utils/message';

// We never persist a session, so the whole Slack thread is the agent's only
// memory, and all of it is replayed VERBATIM until the provider says the
// request got big (owner's call, 2026-10-14: measured, never estimated). After
// every turn the first request's REAL input tokens are stored
// (thread_prompt_sizes); once they reach COMPACT_AT_TOKENS, the next turn folds
// just enough of the oldest messages into the digest to come back to about
// COMPACT_TO_TOKENS, sized by that same request's measured tokens per
// character. Haiku bills the whole request ~5x past 100k, so 90k leaves room
// for the new message and the turn's own tool steps; folding to 60k means it
// happens every ~30k tokens of conversation, not every turn (each fold is a
// summary call and a cache break). A 100-message cap used to fold a
// 449-message working thread at a fraction of this, and its user said kyto had
// "lost a lot of context".
const COMPACT_AT_TOKENS = 90_000;
const COMPACT_TO_TOKENS = 60_000;
// Only for a thread no turn has measured yet (kyto pulled into a huge thread):
// a ceiling so its FIRST request can't overflow the model's context window
// and fail before anything is measured. The next turn has a real count.
const UNMEASURED_MAX_CHARS = 300_000;
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
      cached: true,
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
    return `${BOT_NAME} [app]`;
  }
  if (slack.userAccountId && message.author.userId === slack.userAccountId) {
    return `${BOT_NAME} [user account]`;
  }
  // Said outright so the model knows it is answering a program, not a person.
  return message.author.isBot === true
    ? `${message.author.userName} [bot]`
    : message.author.userName;
}

const quoteRevision = (text: string) => `"${text.replaceAll('\n', ' ⏎ ')}"`;

/** Earlier versions, oldest first, as one line appended to a message. */
function earlierVersions(rows: MessageRevision[]): string {
  const edits = rows.filter((row) => row.kind === 'edited');
  if (edits.length === 0) {
    return '';
  }
  return `\n[edited — earlier ${edits.length === 1 ? 'version' : 'versions, oldest first'}: ${edits.map((row) => quoteRevision(row.text)).join(' → ')}]`;
}

async function renderWithRevisions({
  entry,
  hidden,
  includeHidden,
  revisions,
}: {
  entry: Message;
  hidden: boolean;
  includeHidden: boolean;
  revisions: MessageRevision[];
}): Promise<string> {
  if (hidden && includeHidden) {
    return `[## — hidden from kyto's own turns] ${await renderMessage(entry)}`;
  }
  if (hidden) {
    // Its current text is a `##` message, which kyto never sees; only what it
    // said before the edit is shown.
    return `@${authorLabel(entry)} (${entry.author.userId}): [this message was later edited into one hidden from you]${earlierVersions(revisions)}`;
  }
  return `${await renderMessage(entry)}${earlierVersions(revisions)}`;
}

async function renderDeleted({
  row,
  rows,
}: {
  row: MessageRevision;
  rows: MessageRevision[];
}): Promise<string> {
  const line = mrkdwnToMarkdown(
    await annotateMentions(`<@${row.userId}> (${row.userId}): ${row.text}`)
  );
  return `[deleted by its author] ${line}${earlierVersions(rows)}`;
}

// Channels a message names (`<#C…>`) checked for whether kyto may read them for
// the asker. Without it, a bare channel reference got called private without
// a single read attempt.
const MAX_CHECKED_CHANNELS = 5;
const CHANNEL_REFERENCE = /<#([CG][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Below this a pause is just conversation; above it, the thread replayed as
// one block reads as one moment, and kyto answered week-old state as live.
const GAP_NOTE_MIN_SECONDS = 10 * 60;

/** "The previous message here was 3 days ago", when there was a real pause. */
function gapLine({
  currentId,
  previousId,
}: {
  currentId: string;
  previousId?: string;
}): string[] {
  const gap = Number(currentId) - Number(previousId);
  if (!(previousId && Number.isFinite(gap)) || gap < GAP_NOTE_MIN_SECONDS) {
    return [];
  }
  const minutes = Math.round(gap / 60);
  const hours = Math.round(gap / 3600);
  const days = Math.round(gap / 86_400);
  let ago = `${minutes} minutes`;
  if (days >= 2) {
    ago = `${days} days`;
  } else if (hours >= 2) {
    ago = `${hours} hours`;
  }
  const at = new Date(Number(previousId) * 1000).toISOString();
  return [
    `This conversation resumed after a pause: the message before this one was ${ago} earlier (${at}). What was true then — a status, a deadline, a plan, something you were waiting on — may have changed, so re-check anything time-sensitive instead of treating it as current.`,
  ];
}

async function renderMessage(message: Message): Promise<string> {
  const slackText = rawSlackText(message);
  const text = slackText
    ? mrkdwnToMarkdown(await annotateMentions(withoutFlags(slackText)))
    : withoutFlags(message.text);
  const pronouns = message.author.pronouns
    ? `, ${message.author.pronouns}`
    : '';
  // Only the current message's files reach the sandbox, so "the screenshot
  // above" had no handle at all; the id is what getFile takes.
  const files = message.attachments
    .filter((file) => file.id)
    .map(
      (file) =>
        `${file.name ?? 'file'} (${file.id}${file.mimeType ? `, ${file.mimeType}` : ''})`
    );
  const attached =
    files.length > 0 ? ` [attachments: ${files.join(', ')}]` : '';
  return `@${authorLabel(message)} (${message.author.userId}${pronouns}): ${text}${attached}`;
}

export async function buildPrompt(
  message: Message,
  {
    asUserAccount = false,
    channelInstructions,
    codeChannel,
    customizationPrompt,
    includeHidden = false,
    memoriesOff = false,
    thread,
  }: {
    /** Answering as kyto's Slack user account; per turn, so volatile tail. */
    asUserAccount?: boolean;
    /** The channel's standing instructions; per channel, so the front of history. */
    channelInstructions?: string;
    /** In a code channel (lib/code-channels). Per channel, so volatile tail. */
    codeChannel?: 'native' | 'ordinary';
    customizationPrompt?: string;
    /**
     * Kevinton's review: replay `##` messages too, marked as hidden. People
     * complain about kyto there precisely so it isn't interrupted, which is
     * what a review needs to read. Never for a turn that answers anyone.
     */
    includeHidden?: boolean;
    /** `--NO-MEMORY`: no notebooks and no reasoning replayed from earlier turns. */
    memoriesOff?: boolean;
    thread?: Thread;
  } = {}
): Promise<{
  /** The first message replayed verbatim, stored with the request's size. */
  firstReplayedId?: string;
  history: string[];
  tail: string;
}> {
  // Everything below is independent, so it is read at once: the Slack thread
  // read is the slow part (~0.5s), and awaiting the rest in front of it put
  // every one of their round trips between the ping and the model request.
  const currentChannelId = thread
    ? slack.decodeThreadId(thread.id).channel
    : undefined;
  const [
    current,
    thinking,
    notebooks,
    threadRead,
    revisions,
    canvases,
    channelAccess,
  ] = await Promise.all([
    renderMessage(message),
    // What kyto was THINKING on this thread's last few turns. Slack replayed
    // above only records what it said, so without this each turn re-derives
    // the reasoning (and the dead ends) of the one before it.
    thread && !memoriesOff
      ? recallThinking({
          speakerId: message.author.userId,
          threadId: thread.id,
        }).then(renderThinking)
      : '',
    // The user account reads the global notebook too; the app, only the
    // channel's (lib/notebooks.ts). A failed read costs the notes, not the turn.
    thread && !memoriesOff
      ? renderNotebooks({
          channelId: slack.decodeThreadId(thread.id).channel,
          includeGlobal: asUserAccount,
        }).catch((error: unknown) => {
          logger.warn({ err: error }, '[prompt] could not load the notebooks');
          return '';
        })
      : '',
    thread
      ? Promise.all([
          // Focus mode: drop messages from non-focused users so kyto genuinely
          // never sees what other people said in a focused thread (not just
          // declines to reply). Its own messages and the owner's are always kept.
          thread.state.catch(() => null),
          // Start the read at the newest message an earlier turn already
          // digested. Everything before it is in the summary, so re-reading it
          // would be Slack API work whose only output we already have written down.
          loadThreadSummary(thread.id).then(async (stored) => ({
            fetched: await readThread({
              asUserAccount,
              oldest: stored?.throughMessageId,
              threadId: thread.id,
            }),
            measured: await getThreadPromptSize(thread.id).catch(
              () => undefined
            ),
            stored,
          })),
        ])
      : undefined,
    thread ? threadRevisions(thread.id) : new Map<string, MessageRevision[]>(),
    // A canvas the message links ("rubric: [canvas]") is read for it (#76).
    renderLinkedCanvases({
      askerUserId: message.author.userId,
      attachments: message.attachments,
      currentChannelId,
      text: rawSlackText(message) ?? message.text,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, '[prompt] could not read linked canvases');
      return '';
    }),
    Promise.all(
      [
        ...new Set(
          [...(rawSlackText(message) ?? '').matchAll(CHANNEL_REFERENCE)]
            .map((match) => match[1] ?? '')
            .filter((id) => id && id !== currentChannelId)
        ),
      ]
        .slice(0, MAX_CHECKED_CHANNELS)
        .map(async (channelId) =>
          (await mayReadChannel({
            askerUserId: message.author.userId,
            channelId,
            currentChannelId,
          }))
            ? `<#${channelId}> is readable: it's public or the asker is in it, so read it rather than guessing.`
            : `<#${channelId}> isn't readable for this asker: it isn't public and they aren't in it (or kyto couldn't check).`
        )
    ),
  ]);

  // A native code channel's one conversation, not a thread (lib/code-channels).
  const inChannelConversation =
    thread !== undefined && !slack.decodeThreadId(thread.id).threadTs;
  let history: string[] = [];
  let compacted = '';
  let pulledInLater = false;
  let previousMessageId: string | undefined;
  let firstReplayedId: string | undefined;
  if (thread && threadRead) {
    const [focusState, { measured, stored, fetched: firstRead }] = threadRead;
    let fetched = firstRead;
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
    // A message that was ONLY flags changed settings and never got a turn;
    // with the flags taken off (renderMessage) it would be an empty line.
    const onlyFlags = (entry: Message) => {
      const parsed = parseFlags(withoutLeadingMentions(rawText(entry)));
      return parsed?.ok === true && parsed.flags.rest === '';
    };
    const visible = (entry: Message) =>
      entry.id !== message.id &&
      !onlyFlags(entry) &&
      isFocusAllowed(focusState, entry.author.userId, {
        isMe: entry.author.isMe === true,
      });
    // A message edited INTO a `##` one is still shown, as what it said
    // before: hiding it afterwards must not erase what kyto was asked.
    const prior = (fetched?.messages ?? []).filter(
      (entry) =>
        visible(entry) &&
        (!isHiddenFromBot(entry) || (!includeHidden && revisions.has(entry.id)))
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
    previousMessageId = prior.findLast((entry) => entry.id < message.id)?.id;
    // Split AFTER filtering, so a focused thread's budget is spent on messages
    // kyto may actually see, not on hidden ones.
    // Past whatever the digest already covers, the replay starts at the
    // oldest message — further on only when the last turn's measured request
    // says so (see COMPACT_AT_TOKENS).
    // Never earlier than the last measured window either: a fold bigger than
    // one pass is digested in the background, and until it is stored, the
    // digest's boundary still sits behind it.
    const digested = Number(stored?.throughMessageId ?? 0);
    const measuredFrom = Number(measured?.firstReplayedId ?? 0);
    let start = prior.findIndex(
      (entry) => Number(entry.id) > digested && Number(entry.id) >= measuredFrom
    );
    start = start === -1 ? Math.max(prior.length - 1, 0) : start;
    const sizes = prior.map(
      (entry) => (rawSlackText(entry) || entry.text).length
    );
    let toFold = 0;
    if (!measured) {
      const total = sizes.slice(start).reduce((sum, size) => sum + size, 0);
      toFold = total - UNMEASURED_MAX_CHARS;
    } else if (
      measured.inputTokens >= COMPACT_AT_TOKENS &&
      // A window already cut since that measurement is not cut again on it:
      // the turn that cut it may have failed before measuring its own request.
      (measured.firstReplayedId === null ||
        Number(prior[start]?.id ?? 0) <= Number(measured.firstReplayedId))
    ) {
      toFold =
        ((measured.inputTokens - COMPACT_TO_TOKENS) * measured.requestChars) /
        measured.inputTokens;
    }
    while (toFold > 0 && start < prior.length - 1) {
      toFold -= sizes[start] ?? 0;
      start += 1;
    }
    const overflow = prior.slice(0, start);
    // The `##` messages ride along only inside the replay window, never into
    // `overflow`: the digest it feeds is shared with every later turn, and a
    // hidden message folded into it would reach kyto after all.
    const firstReplayed = prior[start]?.id;
    firstReplayedId = firstReplayed;
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
          // Never the current text of a message edited into a `##` one: the
          // digest is shared by every later turn.
          rendered: await renderWithRevisions({
            entry,
            hidden: isHiddenFromBot(entry),
            includeHidden: false,
            revisions: revisions.get(entry.id) ?? [],
          }),
        }))
      );
      compacted = await compactOverflow({
        overflow: rendered,
        threadId: thread.id,
        ...(stored ? { stored } : {}),
      });
    }
    // Deleted messages are gone from the read, so they are put back at their
    // place by ts — only inside the replay window, like everything else.
    const windowStart = overflow.length > 0 ? firstReplayed : undefined;
    const present = new Set((fetched?.messages ?? []).map((entry) => entry.id));
    const deleted = [...revisions.entries()].flatMap(([ts, rows]) => {
      const gone = rows.find((row) => row.kind === 'deleted');
      return gone &&
        !present.has(ts) &&
        ts !== message.id &&
        (windowStart === undefined || ts >= windowStart)
        ? [{ id: ts, row: gone, rows }]
        : [];
    });
    if (replayed.length > 0 || deleted.length > 0) {
      const lines = await Promise.all([
        ...replayed.map(async (entry) => ({
          id: entry.id,
          line: await renderWithRevisions({
            entry,
            hidden: isHiddenFromBot(entry),
            includeHidden,
            revisions: revisions.get(entry.id) ?? [],
          }),
        })),
        ...deleted.map(async ({ id, row, rows }) => ({
          id,
          line: await renderDeleted({ row, rows }),
        })),
      ]);
      lines.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
      const rendered = lines.map(({ line }) => line);
      history = rendered.map((line, index) =>
        index === 0
          ? `Conversation so far in this Slack ${inChannelConversation ? 'channel' : 'thread'} (oldest first):\n${line}`
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
    ...gapLine({ currentId: message.id, previousId: previousMessageId }),
    ...(channelAccess.length > 0
      ? [`Channels this message mentions:\n${channelAccess.join('\n')}`]
      : []),
    // The system prompt names both identities without saying which is "you"
    // (it is one cached prefix for both), so every turn says it here.
    ...(slack.userAccountId && slack.botUserId
      ? [
          asUserAccount
            ? `In THIS turn you are kyto's user account, Slack id ${slack.userAccountId}: a message mentioning <@${slack.userAccountId}> is addressed to YOU; <@${slack.botUserId}> is the kyto app, your other half.`
            : `In THIS turn you are the kyto app, Slack id ${slack.botUserId}: a message mentioning <@${slack.botUserId}> is addressed to YOU; <@${slack.userAccountId}> is kyto's user account, your other half.`,
        ]
      : []),
    ...(asUserAccount
      ? [
          'You are answering as kyto\'s own Slack USER account — a regular member account named kyto, not the kyto app — so talk like a person in Slack does: short and casual, usually a line or two, no headings, no bullet lists unless the answer really is a list, no sign-offs or offers of more help. Nobody sees your plan, tool calls or reasoning, only what you write. On a longer task, one or two very short status lines before the answer are fine ("on it, give me a sec"); otherwise write only the answer. If the message isn\'t for you or needs no reply, call skip — nothing at all is shown. Your tools are the same as always.',
        ]
      : []),
    ...(pulledInLater
      ? [
          "This message doesn't mention you, and this thread didn't start with you — someone brought you in partway, so you're seeing every reply here, most of them people talking to each other. Decide whether this one needs you: reply only if it's addressed to you, follows up on something you said, or asks something you should clearly answer. Otherwise call skip — nothing is posted.",
        ]
      : []),
    ...(codeChannel === 'ordinary'
      ? [
          'This is a CODE CHANNEL: every top-level message here is for you without a mention, and every thread in the channel shares ONE sandbox workspace — files from earlier threads are already there, so check before starting over. Earlier threads are readable with the Slack history tools.',
        ]
      : []),
    ...(codeChannel === 'native' && thread && inChannelConversation
      ? [
          "This is a Slack CODE CHANNEL and you are its agent: the whole channel is ONE conversation with you about one task — every message here is for you, no mention needed — and your replies go at the top level. The channel has one sandbox workspace; what you built earlier is still there. Show your work in the channel's tabs with the codeChannel tool (a `diff` tab after changing code, the pull request as a `pull_request` tab, a `canvas` tab for a plan people can comment on) and keep the context bar on the repo, branch and PR. Archive the channel only when someone asks.",
        ]
      : []),
    ...(codeChannel === 'native' && thread && !inChannelConversation
      ? [
          "This thread is inside a Slack CODE CHANNEL you are the agent of: someone started a thread off the channel's main conversation, so answer here. The task itself is the channel's top-level conversation (read it with readConversationHistory on this channel if you need it); the sandbox is the same one.",
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
  //   compacted           changes only when a measured request was too big
  //   history             append-only until the thread passes MAX_REPLAY_TOKENS
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
    firstReplayedId,
    history: [
      channelInstructions
        ? [
            '<channel_instructions>',
            channelInstructions,
            '</channel_instructions>',
          ].join('\n')
        : '',
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
    tail: [thinking, nowLine, latest, canvases].filter(Boolean).join('\n\n'),
  };
}

/**
 * How code work is done on the attempt about to run, added to ITS prompt —
 * per attempt, not per turn (owner's call, 2026-10-14): on the person's own
 * key OpenCode is never mentioned (and the tool is hidden); on kyto's shared
 * key — the first try, or a fallback after their key failed — it is the rule.
 */
export function codingLine({ ownKey }: { ownKey: boolean }): string {
  return ownKey
    ? "Coding on this turn: it runs on the person's OWN model key, so do real code work yourself — write, build, run and debug in your own shell."
    : 'Coding on this turn (a hard rule — Hack Club AI provides your shared model on the condition that it does not do coding-agent work): do real code work through the `opencode` tool, not your own shell. Give it a complete brief in your own words and put nothing from Slack in it: no quoted messages, no names. Then deliver the result as your own work. Don\'t bring up OpenCode, delegating or any coding restriction on your own (if asked how it was done, you may say). A `<coding_work>` note, or a tool call answered "Not run", means exactly this: move that work to `opencode`, without commenting on it. For reading or searching a repo, use bash: OpenCode takes minutes for what grep does in seconds.';
}
