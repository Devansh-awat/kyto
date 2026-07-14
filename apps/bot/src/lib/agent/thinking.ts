// Kyto's memory of a conversation is the Slack thread itself (buildPrompt
// replays it). But Slack only records what was SAID — the reasoning that led to
// it is rendered into the plan's "Thinking" cards and then gone. So every turn
// used to start cold: kyto could see that it had said "let me check all 50
// slider positions" but not why, what it had already ruled out, or what it was
// part-way through. It re-derived the same dead ends.
//
// This keeps the reasoning of a thread's last few turns, in memory only, and
// buildPrompt feeds it back on the next turn.
//
// IN MEMORY ONLY, deliberately — never a DB table. Kyto's Slack Scraping
// position is that it does live processing and does not store message contents,
// and reasoning quotes message contents freely. Process lifetime is also the
// honest lifetime for this: it's a train of thought, not a record.

interface ThreadThinking {
  turns: string[];
  updatedAt: number;
}

// How many past turns of reasoning a new turn is shown. Three keeps the thread's
// recent train of thought without letting an old turn's plan crowd out the live
// one — and the prompt cost is bounded by MAX_TURN_CHARS below.
const MAX_TURNS = 3;
// Per-turn cap. Reasoning runs long (a tool-heavy turn can think for thousands
// of tokens); the tail is what matters, since that is where the turn had
// actually worked out what was going on. Cutting from the FRONT keeps it.
const MAX_TURN_CHARS = 1500;
// A thread nobody has touched in this long is dropped. Bounds the map, and a
// stale train of thought is worse context than none.
const TTL_MS = 12 * 60 * 60 * 1000;

const threads = new Map<string, ThreadThinking>();

function prune(now: number): void {
  for (const [threadId, entry] of threads) {
    if (now - entry.updatedAt > TTL_MS) {
      threads.delete(threadId);
    }
  }
}

/**
 * Record one completed turn's reasoning. Called with the reasoning blocks of the
 * attempt that actually ANSWERED — a failed attempt's thinking is discarded with
 * the attempt, so a model that spiralled doesn't poison the next turn.
 */
export function rememberThinking({
  blocks,
  threadId,
}: {
  blocks: string[];
  threadId: string;
}): void {
  const text = blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) {
    return;
  }
  const now = Date.now();
  prune(now);
  const entry = threads.get(threadId) ?? { turns: [], updatedAt: now };
  entry.turns.push(tail(text, MAX_TURN_CHARS));
  entry.turns = entry.turns.slice(-MAX_TURNS);
  entry.updatedAt = now;
  threads.set(threadId, entry);
}

/** The reasoning of this thread's last few turns, oldest first. */
export function recallThinking(threadId: string): string[] {
  const entry = threads.get(threadId);
  if (!entry || Date.now() - entry.updatedAt > TTL_MS) {
    return [];
  }
  return entry.turns;
}

/** Forget a thread's train of thought (a new turn is starting from scratch). */
export function forgetThinking(threadId: string): void {
  threads.delete(threadId);
}

/**
 * The block buildPrompt injects. Framed hard, because the failure mode of
 * showing a model its own past reasoning is that it narrates or re-litigates it
 * instead of moving on.
 */
export function renderThinking(turns: string[]): string {
  if (turns.length === 0) {
    return '';
  }
  const rendered = turns.map((turn, index) => {
    const ago = turns.length - index;
    const label = ago === 1 ? 'your previous turn' : `${ago} turns ago`;
    return `[${label}]\n${turn}`;
  });
  return [
    '<your_previous_thinking>',
    'Your own private reasoning from earlier turns in THIS thread, oldest first. Nobody in Slack can see it — Slack only kept what you said out loud, so this is the only way you still have your train of thought.',
    'Use it to pick up where you left off: what you already tried, ruled out, or were part-way through. Do NOT narrate it, quote it, or apologise for it — it is a memory, not something the user said.',
    '',
    ...rendered,
    '</your_previous_thinking>',
  ].join('\n');
}

function tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `…${text.slice(-max)}`;
}
