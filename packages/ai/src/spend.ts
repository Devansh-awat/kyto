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
  source: string;
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
  steps,
}: {
  effort: string | undefined;
  model: string;
  provider: string;
  source: string;
  steps: readonly {
    usage: {
      inputTokenDetails?: { cacheReadTokens?: number };
      inputTokens?: number;
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
  for (const step of steps) {
    inputTokens += step.usage.inputTokens ?? 0;
    cacheReadTokens += step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    outputTokens += step.usage.outputTokens ?? 0;
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
    source,
  });
}
