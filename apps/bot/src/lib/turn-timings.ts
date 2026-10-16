import {
  effortStats,
  listTurnTimings,
  pruneTurnTimings,
  recordTurnTiming,
  type TurnTiming,
} from '@repo/db/queries';
import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Stage timings of every turn, queryable for 30 days (owner's ask,
// 2026-10-11). `!timings` shows a thread's last few; `!debug` freezes them.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SHOWN_TURNS = 5;

export async function saveTurnTiming({
  messageTs,
  outcome,
  threadId,
  timing,
}: {
  messageTs: string;
  outcome: 'complete' | 'failed' | 'interrupted';
  threadId: string;
  timing: Record<string, unknown> & { totalMs: number };
}): Promise<void> {
  await recordTurnTiming({
    messageTs,
    outcome,
    threadId,
    timing,
    totalMs: Math.round(timing.totalMs),
  }).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), threadId },
      '[timings] could not save a turn timing'
    );
  });
}

const timingSchema = z.looseObject({
  answeredBy: z.string().optional(),
  ingressMs: z.number().optional(),
  jevMs: z.number().optional(),
  modelCalls: z.number().optional(),
  modelMs: z.number().optional(),
  promptMs: z.number().optional(),
  reasoningEffort: z.string().optional(),
  setupMs: z.number().optional(),
  slowestTools: z
    .array(z.object({ ms: z.number(), name: z.string() }))
    .optional(),
  toolMs: z.number().optional(),
  ttftMs: z.array(z.number()).optional(),
});

const seconds = (ms: number | undefined) =>
  ms === undefined ? undefined : `${(ms / 1000).toFixed(1)}s`;

/** One line per turn: where its time went. */
export function describeTiming(row: TurnTiming): string {
  const timing = timingSchema.safeParse(row.timing).data ?? {};
  const parts = [
    `*${row.createdAt.toISOString().slice(11, 16)} UTC* · ${seconds(row.totalMs)} total${row.outcome && row.outcome !== 'complete' ? ` (${row.outcome})` : ''}`,
    timing.ingressMs === undefined
      ? undefined
      : `slack→kyto ${seconds(timing.ingressMs)}`,
    timing.setupMs === undefined
      ? undefined
      : `setup ${seconds(timing.setupMs)}`,
    timing.ttftMs?.[0] === undefined
      ? undefined
      : `first token ${seconds(timing.ttftMs[0])}`,
    timing.modelMs === undefined
      ? undefined
      : `model ${seconds(timing.modelMs)} over ${timing.modelCalls ?? '?'} calls`,
    timing.toolMs ? `tools ${seconds(timing.toolMs)}` : undefined,
    timing.slowestTools?.[0]
      ? `slowest ${timing.slowestTools[0].name} ${seconds(timing.slowestTools[0].ms)}`
      : undefined,
    timing.answeredBy
      ? `${timing.answeredBy}${timing.reasoningEffort ? `/${timing.reasoningEffort}` : ''}`
      : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** `!timings`: this thread's last few turns, newest first. */
export async function describeThreadTimings(threadId: string): Promise<string> {
  const rows = await listTurnTimings({ limit: SHOWN_TURNS, threadId });
  if (rows.length === 0) {
    return 'no turns in this thread have recorded timings yet.';
  }
  return [
    `last ${rows.length} ${rows.length === 1 ? 'turn' : 'turns'} here, newest first:`,
    ...rows.map((row) => `• ${describeTiming(row)}`),
  ].join('\n');
}

export function startTimingsReaper(): void {
  const prune = () =>
    pruneTurnTimings(new Date(Date.now() - RETENTION_MS)).catch(
      (error: unknown) => {
        logger.warn({ err: errorMessage(error) }, '[timings] prune failed');
      }
    );
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EFFORT_DAYS = 7;
// Turn timings are kept 30 days.
const MAX_EFFORT_DAYS = 30;

/**
 * `!effort [days]` (owner only): the effort experiment per model × effort,
 * drawn and chosen efforts together (each cell says how many were drawn).
 */
export async function describeEffortStats(args: string): Promise<string> {
  const days = Math.min(
    Math.max(Number(args.match(/\d+/)?.[0]) || DEFAULT_EFFORT_DAYS, 1),
    MAX_EFFORT_DAYS
  );
  const cells = await effortStats({
    since: new Date(Date.now() - days * DAY_MS),
  });
  if (cells.length === 0) {
    return `No turns in the last ${days} days.`;
  }
  const round = (value: number | null, digits = 0) =>
    value === null ? '?' : value.toFixed(digits);
  const lines = cells.map((cell) =>
    [
      `*${cell.model} · ${cell.effort}* (${cell.turns} turns, ${cell.drawn} drawn${cell.up + cell.down > 0 ? `, ${cell.up}👍 ${cell.down}👎` : ''})`,
      `  time: median ${seconds(cell.medianTotalMs ?? undefined) ?? '?'} (p90 ${seconds(cell.p90TotalMs ?? undefined) ?? '?'}), model ${seconds(cell.medianModelMs ?? undefined) ?? '?'} · cost $${round(cell.avgCostUsd, 4)}/turn · ${round(cell.steps, 1)} steps · reply ${round(cell.replyChars)} chars`,
      `  thinking: ${round(cell.tokensPerTurn)} tokens/turn, ${round(cell.tokensPerThinkingStep)}/thinking step, ${round(cell.reasoningShare === null ? null : cell.reasoningShare * 100)}% of output · ${round(cell.thinkMsPerStep === null ? null : cell.thinkMsPerStep / 1000, 1)}s before answering per step · ${round(cell.tokensPerThinkSecond)} tok/s`,
      `  shown: ${round(cell.charsPerBlock)} chars/block, ${round(cell.charsPerToken, 2)} chars/token, ${round(cell.reasoningCharsPerSecond)} chars/s`,
    ].join('\n')
  );
  return `*Effort experiment, last ${days} days* (drawn and chosen efforts together; turns before 2026-10-16 have no thinking numbers)\n${lines.join('\n')}`;
}
