import {
  clearThreadThinking,
  getThreadThinking,
  pruneThreadThinking,
  saveThreadThinking,
} from '@repo/db/queries';
import logger from '@/lib/logger';

// Kyto's memory of a conversation is the Slack thread itself (buildPrompt
// replays it). But Slack only records what was SAID — the reasoning that led to
// it is rendered into the plan's "Thinking" cards and then gone. So every turn
// used to start cold: kyto could see that it had said "let me check all 50
// slider positions" but not why, what it had already ruled out, or what it was
// part-way through. It re-derived the same dead ends.
//
// This keeps the reasoning of a thread's last few turns and buildPrompt feeds it
// back on the next turn. PERSISTED to Postgres (thread_thinking) so it survives
// a restart — the old in-memory buffer was wiped on every deploy, which is why a
// thread picked back up after a restart lost its train of thought. Rows are
// reaped after RETENTION_MS so this stays a recent train of thought, not a
// permanent transcript.

// How many past turns of reasoning a new turn is shown. Enough to cover a
// multi-turn investigation (kyto solves something over several turns, then a
// later turn asks about the result) without letting ancient turns crowd out the
// live one. Prompt cost is bounded by MAX_TURN_CHARS below.
const MAX_TURNS = 6;
// Per-turn cap on the WHOLE record (reasoning + observations). Reasoning and
// tool output both run long; the tail is what matters, since that is where the
// turn had actually worked out what was going on and what its tools returned.
// Cutting from the FRONT keeps it.
const MAX_TURN_CHARS = 6000;
// How long a thread's stored reasoning stays usable and on disk (~a month).
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Record one completed turn's reasoning AND what its tools observed. Called with
 * the reasoning blocks and tool observations of the attempt that actually
 * ANSWERED — a failed attempt's thinking is discarded with the attempt, so a
 * model that spiralled doesn't poison the next turn.
 *
 * Slack replays only what kyto SAID, never what it thought or what a tool
 * returned — so a fact kyto worked out but never typed (a captcha it decoded, an
 * OCR result, a computed value) is otherwise lost the moment the turn ends. Both
 * halves ride back into the next turn via buildPrompt.
 *
 * Best-effort: a DB hiccup here must never fail the turn.
 */
export async function rememberThinking({
  blocks,
  observations,
  threadId,
}: {
  blocks: string[];
  /** Pre-rendered, already-clamped summary of the turn's tool results. */
  observations?: string;
  threadId: string;
}): Promise<void> {
  const reasoning = blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
  const trimmedObservations = observations?.trim();
  const text = [
    reasoning,
    trimmedObservations
      ? `[what your tools returned this turn]\n${trimmedObservations}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!text) {
    return;
  }
  try {
    const existing = await getThreadThinking(threadId, RETENTION_MS);
    const turns = [...existing, tail(text, MAX_TURN_CHARS)].slice(-MAX_TURNS);
    await saveThreadThinking(threadId, turns);
  } catch (error) {
    logger.warn({ err: error, threadId }, '[thinking] failed to persist');
  }
}

/** The reasoning of this thread's last few turns, oldest first. */
export async function recallThinking(threadId: string): Promise<string[]> {
  return await getThreadThinking(threadId, RETENTION_MS).catch(() => []);
}

/** Forget a thread's train of thought (a new turn is starting from scratch). */
export async function forgetThinking(threadId: string): Promise<void> {
  await clearThreadThinking(threadId).catch(() => undefined);
}

// Reap reasoning older than the retention window, on startup and daily after.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pruneThinking(): Promise<void> {
  await pruneThreadThinking(new Date(Date.now() - RETENTION_MS)).catch(
    (error: unknown) => {
      logger.warn({ err: error }, '[thinking] prune failed');
    }
  );
}

export function startThinkingReaper(): void {
  const tick = (): void => {
    pruneThinking().catch(() => undefined);
  };
  setInterval(tick, PRUNE_INTERVAL_MS);
  tick();
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
    'Your own private reasoning AND what your tools returned in earlier turns in THIS thread, oldest first. Nobody in Slack can see it — Slack only kept what you said out loud, so this is the only way you still have your train of thought and the facts your tools uncovered (a value you computed, a captcha you decoded, an OCR result) but never typed into a message.',
    'Use it to pick up where you left off: what you already tried, ruled out, were part-way through, or found. Do NOT narrate it, quote it, or apologise for it — it is a memory, not something the user said.',
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
