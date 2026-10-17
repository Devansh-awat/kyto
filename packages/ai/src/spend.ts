import type { CallStats } from './call-stats';
import { stepsCacheWrites, stepsCostUsd } from './usage-cost';

/**
 * One model call's bill, handed to whoever registered a sink (the bot writes it
 * to `model_spend`). This package has no database, and a hook here is the one
 * place every call passes — turns, subagents, Kevinton, compaction, recovery —
 * so no caller can forget to report.
 */
export interface SpendRecord {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  effort: string | null;
  inputTokens: number;
  model: string;
  outputTokens: number;
  provider: string;
  /** Part of `outputTokens`: thinking, shown or hidden. */
  reasoningTokens: number;
  source: string;
  /** Per-step timing and amounts (call-stats.ts); absent if none was measured. */
  stats?: CallStats;
}

let sink: ((record: SpendRecord) => void) | undefined;

export function setSpendSink(next: (record: SpendRecord) => void): void {
  sink = next;
}

export function reportSpend({
  effort,
  model,
  provider,
  source,
  stats,
  steps,
}: {
  effort: string | undefined;
  model: string;
  provider: string;
  source: string;
  stats?: CallStats;
  steps: readonly {
    usage: {
      inputTokenDetails?: { cacheReadTokens?: number };
      inputTokens?: number;
      outputTokenDetails?: { reasoningTokens?: number };
      outputTokens?: number;
      raw?: unknown;
    };
  }[];
}): void {
  if (!sink || steps.length === 0) {
    return;
  }
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  for (const step of steps) {
    inputTokens += step.usage.inputTokens ?? 0;
    cacheReadTokens += step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    outputTokens += step.usage.outputTokens ?? 0;
    reasoningTokens += step.usage.outputTokenDetails?.reasoningTokens ?? 0;
  }
  sink({
    cacheReadTokens,
    cacheWriteTokens: stepsCacheWrites(steps).reduce((a, b) => a + b, 0),
    costUsd: stepsCostUsd(steps) ?? null,
    effort: effort ?? null,
    inputTokens,
    model,
    outputTokens,
    provider,
    reasoningTokens,
    source,
    ...(stats ? { stats } : {}),
  });
}
