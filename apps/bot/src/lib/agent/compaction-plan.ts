// The decision half of compaction, kept free of the DB and the logger (and so of
// the validated env) so it can be tested directly. lib/agent/compaction does the
// IO — read the stored summary, call a model, write it back — and asks this
// module what to do.

// How many messages must have newly fallen out of the replay window before the
// summary is refreshed. Without this, every turn in a thread past the cap pushes
// exactly one more message into overflow and pays for a whole summarization pass
// to absorb it. Below the threshold the block still reports the true count, so
// nothing is hidden — the gap is described rather than digested. A thread
// crossing the cap for the FIRST time is summarized immediately regardless.
export const COMPACT_BATCH = 25;
// Messages folded into ONE model call. A backlog bigger than this is split into
// several passes that each extend the previous digest, rather than being clamped
// to the newest slice and having the rest silently dropped.
export const MAX_MESSAGES_PER_PASS = 200;

/** One overflowed message, already rendered by buildPrompt. */
export interface CompactableMessage {
  id: string;
  rendered: string;
}

export interface StoredSummary {
  /** How many earlier messages the stored summary already accounts for. */
  coveredCount: number;
  summary: string;
  /** Id of the newest message the stored summary already accounts for. */
  throughMessageId: string;
}

export interface CompactionPlan {
  /**
   * Every message earlier than the replay window, digested or not — including
   * the ones an earlier turn already folded in and this turn never fetched.
   * This is what the block reports, so the count stays true for the whole
   * thread rather than for whatever slice happened to be in hand.
   */
  count: number;
  /**
   * Chunks to fold in, oldest first, each extending the digest the pass before
   * it produced. Empty when the stored digest still stands.
   */
  passes: CompactableMessage[][];
  /** The digest the passes extend, when this is an incremental catch-up. */
  previous?: string;
}

/**
 * Messages in `overflow` that the stored digest does not already cover.
 *
 * Matched by TIMESTAMP, not by position: a Slack message id is its ts, so
 * "newer than the last one we digested" is a total order that survives the
 * things an index lookup does not — a deleted message, the thread root that
 * `conversations.replies` prepends to every page, and an incremental fetch that
 * deliberately starts mid-thread and so never contains the older ids at all.
 * Falls back to an exact id match when the ids are not timestamps (tests, and
 * any future non-Slack caller).
 */
function pendingAfter(
  overflow: CompactableMessage[],
  through: string
): CompactableMessage[] {
  const boundary = Number(through);
  if (Number.isFinite(boundary)) {
    return overflow.filter((message) => {
      const at = Number(message.id);
      return Number.isFinite(at) ? at > boundary : false;
    });
  }
  const index = overflow.findIndex((message) => message.id === through);
  return index === -1 ? overflow : overflow.slice(index + 1);
}

function chunk(
  messages: CompactableMessage[],
  size: number
): CompactableMessage[][] {
  const passes: CompactableMessage[][] = [];
  for (let at = 0; at < messages.length; at += size) {
    passes.push(messages.slice(at, at + size));
  }
  return passes;
}

/**
 * What to do with the messages that fell out of the replay window.
 *
 * `overflow` is oldest-first and may legitimately overlap what the stored digest
 * already covers; anything at or before its `throughMessageId` is ignored.
 * Returns undefined when there is nothing earlier at all — no overflow this turn
 * and nothing digested on a previous one.
 */
export function planCompaction({
  overflow,
  stored,
}: {
  overflow: CompactableMessage[];
  stored?: StoredSummary;
}): CompactionPlan | undefined {
  const pending = stored
    ? pendingAfter(overflow, stored.throughMessageId)
    : overflow;
  const count = (stored?.coveredCount ?? 0) + pending.length;
  if (count === 0) {
    return;
  }
  // Below the threshold the digest is left alone: refreshing it for a couple of
  // messages costs a model call per turn forever. The count still moves.
  if (stored && pending.length < COMPACT_BATCH) {
    return { count, passes: [], previous: stored.summary };
  }
  return {
    count,
    passes: chunk(pending, MAX_MESSAGES_PER_PASS),
    ...(stored ? { previous: stored.summary } : {}),
  };
}

/**
 * The block for a thread too long to read to the end.
 *
 * There is no count here on purpose: kyto genuinely does not know how many
 * messages it did not see, and inventing a number would be worse than saying
 * so. Compaction is skipped for such a turn, because a slice that does not join
 * onto the stored digest cannot be folded into it — so a digest from before,
 * when there is one, is shown as-is.
 */
export function renderUnreadableBlock({
  summary,
}: {
  summary?: string;
}): string {
  const header =
    '<earlier_in_this_thread>\nThis thread is far too long to read in full — you are seeing only its most recent messages, and there is a large amount of earlier conversation you cannot see. Do not treat the replay below as the beginning.';
  const digest = summary
    ? `\n\nA digest of an earlier part of it:\n\n${summary}`
    : '';
  return `${header}${digest}\n\nUse the Slack history tools to read a specific stretch if you need it, and say plainly that you cannot see the whole thread rather than guessing.\n</earlier_in_this_thread>`;
}

/**
 * The prompt block. It ALWAYS states the count, with or without a summary —
 * that is the whole point of this feature. Silent truncation is what it
 * replaces, so a failed summary must still leave the model knowing the
 * conversation has a beginning it cannot see.
 */
export function renderCompactedBlock({
  count,
  summary,
  undigested = 0,
}: {
  count: number;
  summary?: string;
  /** Earlier messages not yet folded into the digest, if any. */
  undigested?: number;
}): string {
  const header = `<earlier_in_this_thread>\nThis thread has ${count} earlier message(s) that no longer fit in the replay below. They are part of the SAME conversation — do not treat the replayed history as its beginning.`;
  if (!summary) {
    return `${header}\n\nThey could not be summarized this turn, so you are seeing only the count. If anything below seems to reference something you cannot see, it is probably in there — read it with the Slack history tools rather than guessing or asking the user to repeat themselves.\n</earlier_in_this_thread>`;
  }
  const gap =
    undigested > 0
      ? `\n\nThe ${undigested} most recent of those are not in the digest yet — they are still being folded in. Read them with the Slack history tools if something below refers to them.`
      : '';
  return `${header}\n\n${summary}${gap}\n\nThis is a compacted digest, not a transcript. If you need something it does not cover, read the thread with the Slack history tools.\n</earlier_in_this_thread>`;
}
