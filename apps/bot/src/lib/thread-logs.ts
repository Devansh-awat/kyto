import {
  appendThreadLogs,
  pruneThreadLogs,
  readThreadLogs,
} from '@repo/db/queries';
import logger, { takeThreadLogLines } from '@/lib/logger';

// Persists the per-thread log capture (see lib/logger) for kevinton.

const FLUSH_MS = 10_000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_MS = 60 * 60 * 1000;

/** Write what has been captured. Called on a timer and at shutdown. */
export async function flushThreadLogs(): Promise<void> {
  const taken = takeThreadLogLines();
  if (taken.size === 0) {
    return;
  }
  await appendThreadLogs(
    [...taken].map(([threadId, lines]) => ({
      lines: lines.join('\n'),
      threadId,
    }))
  ).catch((error: unknown) => {
    // Not logged through `logger` inside a thread context, so this cannot
    // recurse into the capture.
    logger.warn({ err: error }, '[thread-logs] flush failed; lines dropped');
  });
}

export function startThreadLogs(): void {
  setInterval(() => {
    flushThreadLogs().catch(() => undefined);
  }, FLUSH_MS);
  const prune = () =>
    pruneThreadLogs(new Date(Date.now() - KEEP_MS)).catch(() => undefined);
  prune();
  setInterval(prune, PRUNE_MS);
}

const TIMING_LINE =
  /\[agent\] turn (?:complete|interrupted|failed)|\[stream\] attempt stream ended|\[sandbox\] (?:materialized|paused)/;
const MAX_TIMING_LINES = 40;
const MAX_TIMING_LINE_CHARS = 2000;

/**
 * A thread's captured log, oldest first, as one string. Past `maxChars` the
 * OLDEST lines are dropped — the end of a turn is where it went wrong.
 */
export async function threadLogText({
  maxChars,
  since,
  threadId,
}: {
  maxChars: number;
  since?: Date;
  threadId: string;
}): Promise<{ text: string; timing: string[]; truncated: boolean }> {
  const rows = await readThreadLogs({ threadId, ...(since ? { since } : {}) });
  const text = rows.map((row) => row.lines).join('\n');
  // Each turn's time breakdown, picked out BEFORE the cut: in a long thread
  // the oldest turns' lines are the first to go, and with them any answer to
  // "where did that slow turn's time go".
  const timing = text
    .split('\n')
    .filter((line) => TIMING_LINE.test(line))
    .slice(-MAX_TIMING_LINES)
    .map((line) => line.slice(0, MAX_TIMING_LINE_CHARS));
  return text.length > maxChars
    ? {
        text: `…(older lines cut)\n${text.slice(-maxChars)}`,
        timing,
        truncated: true,
      }
    : { text, timing, truncated: false };
}
