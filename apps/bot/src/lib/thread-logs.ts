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
}): Promise<{ text: string; truncated: boolean }> {
  const rows = await readThreadLogs({ threadId, ...(since ? { since } : {}) });
  const text = rows.map((row) => row.lines).join('\n');
  return text.length > maxChars
    ? { text: `…(older lines cut)\n${text.slice(-maxChars)}`, truncated: true }
    : { text, truncated: false };
}
