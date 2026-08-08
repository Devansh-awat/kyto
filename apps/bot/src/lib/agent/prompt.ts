import {
  type Message,
  mrkdwnToMarkdown,
  type ThreadHandle as Thread,
} from '@/harness';
import { compactOverflow, loadThreadSummary } from '@/lib/agent/compaction';
import { renderUnreadableBlock } from '@/lib/agent/compaction-plan';
import { isFocusAllowed } from '@/lib/agent/focus';
import { annotateMentions } from '@/lib/agent/mentions';
import { recallThinking, renderThinking } from '@/lib/agent/thinking';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { isHiddenFromBot, rawSlackText } from '@/lib/utils/message';

// We never persist a session, so the whole Slack thread is the agent's only
// memory. Cap how many prior messages we replay VERBATIM to bound prompt size.
const MAX_THREAD_MESSAGES = 100;
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

function readThread(
  threadId: string,
  oldest?: string
): Promise<{ messages: Message[]; nextCursor?: string } | undefined> {
  return slack
    .fetchMessages(threadId, {
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
  return message.author.userName;
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
    customizationPrompt,
    thread,
  }: {
    customizationPrompt?: string;
    thread?: Thread;
  } = {}
): Promise<string> {
  const current = await renderMessage(message);

  // What kyto was THINKING on this thread's last few turns. Slack replayed above
  // only records what it said, so without this each turn re-derives the reasoning
  // (and the dead ends) of the one before it.
  const thinking = thread
    ? renderThinking(await recallThinking(thread.id))
    : '';

  let history = '';
  let compacted = '';
  if (thread) {
    // Focus mode: drop messages from non-focused users so kyto genuinely never
    // sees what other people said in a focused thread (not just declines to
    // reply). Its own messages and the owner's are always kept.
    const focusState = await thread.state.catch(() => null);
    // Start the read at the newest message an earlier turn already digested.
    // Everything before it is in the summary, so re-reading it would be Slack
    // API work whose only output we already have written down.
    const stored = await loadThreadSummary(thread.id);
    let fetched = await readThread(thread.id, stored?.throughMessageId);
    // A cursor left over means the walk ran out of budget BEFORE the end of the
    // thread — so what we hold is a middle slice, and replaying its last 100
    // messages would hand the model a conversation from months ago as if it
    // were live. A real thread hit this: 25,000+ messages. Re-anchor near now,
    // which always reaches the end, and give up on compaction for this turn
    // rather than fold a slice that does not join onto the stored digest.
    let contiguous = true;
    if (fetched?.nextCursor) {
      const recent = await readThread(thread.id, recentAnchor(message.id));
      logger.warn(
        { threadId: thread.id },
        '[prompt] thread is longer than the history ceiling; reading only recent messages'
      );
      if (recent) {
        fetched = recent;
        contiguous = false;
      }
    }
    const prior = (fetched?.messages ?? []).filter(
      (entry): entry is Message =>
        entry.id !== message.id &&
        !isHiddenFromBot(entry) &&
        isFocusAllowed(focusState, entry.author.userId, {
          isMe: entry.author.isMe === true,
        })
    );
    // Split AFTER filtering, so a focused thread's window is 100 messages kyto
    // may actually see rather than 100 slots partly spent on hidden ones.
    const replayed = prior.slice(-MAX_THREAD_MESSAGES);
    const overflow = prior.slice(
      0,
      Math.max(prior.length - replayed.length, 0)
    );
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
      const rendered = await Promise.all(replayed.map(renderMessage));
      history = [
        'Conversation so far in this Slack thread (oldest first):',
        ...rendered,
      ].join('\n');
    }
  }

  // The label that introduces the new message. Kept with `current` rather than
  // appended to `history`, because the thinking block now sits BETWEEN them —
  // and a "the latest message is next" line followed by a page of last turn's
  // reasoning reads as if the reasoning were the message.
  const latest = history
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
  ].join('\n');

  // ORDER IS LOAD-BEARING, for prompt caching (see addCacheControl in
  // packages/ai/src/agent.ts — the breakpoint lands on the last user message,
  // which is this whole string).
  //
  // Cheapest → most volatile, so the cacheable prefix is as long as possible:
  //
  //   user_instructions   changes only when the user edits them
  //   compacted           changes once per COMPACT_BATCH of overflow
  //   history             append-only until the thread passes MAX_THREAD_MESSAGES
  //   thinking            CHANGES EVERY TURN (last turn's reasoning is appended)
  //   nowLine + current   the clock, the message id, and the new message
  //
  // The thinking block used to come FIRST. It is up to THINKING_BUDGET_CHARS of
  // text that is different on every single turn, so putting it at the front
  // invalidated the cached prefix at byte ~0 and the entire replayed thread was
  // re-billed at full price every turn — on a $3/day shared cap. Moving it below
  // the history costs nothing (the model reads the whole prompt either way) and
  // makes system + instructions + history a stable prefix that actually caches.
  //
  // Do NOT move a volatile block back above `history`.
  const body = [
    customizationPrompt
      ? [
          '<user_instructions>',
          customizationPrompt,
          '</user_instructions>',
        ].join('\n')
      : '',
    compacted,
    history,
    thinking,
    nowLine,
    latest,
  ]
    .filter(Boolean)
    .join('\n\n');

  return body;
}
