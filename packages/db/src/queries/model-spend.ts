import { gte, sql } from 'drizzle-orm';
import { db } from '../client';
import { type ModelSpend, modelSpend } from '../schema';

export type { ModelSpend } from '../schema';

export async function recordModelSpend(
  row: Omit<ModelSpend, 'createdAt' | 'id'>
): Promise<void> {
  await db.insert(modelSpend).values(row);
}

export interface SpendGroup {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  costUsd: number;
  effort: string | null;
  inputTokens: number;
  model: string;
  outputTokens: number;
  source: string;
  unpriced: number;
}

/** Spend since `since`, grouped by what spent it, model and effort. */
export async function summarizeModelSpend(since: Date): Promise<SpendGroup[]> {
  const rows = await db
    .select({
      cacheReadTokens: sql<string>`sum(${modelSpend.cacheReadTokens})`,
      cacheWriteTokens: sql<string>`sum(${modelSpend.cacheWriteTokens})`,
      calls: sql<string>`count(*)`,
      costUsd: sql<string>`coalesce(sum(${modelSpend.costUsd}), 0)`,
      effort: modelSpend.effort,
      inputTokens: sql<string>`sum(${modelSpend.inputTokens})`,
      model: modelSpend.model,
      outputTokens: sql<string>`sum(${modelSpend.outputTokens})`,
      source: modelSpend.source,
      unpriced: sql<string>`count(*) filter (where ${modelSpend.costUsd} is null)`,
    })
    .from(modelSpend)
    .where(gte(modelSpend.createdAt, since))
    .groupBy(modelSpend.source, modelSpend.model, modelSpend.effort);
  // Postgres sums come back as strings.
  return rows.map((row) => ({
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    calls: Number(row.calls),
    costUsd: Number(row.costUsd),
    effort: row.effort,
    inputTokens: Number(row.inputTokens),
    model: row.model,
    outputTokens: Number(row.outputTokens),
    source: row.source,
    unpriced: Number(row.unpriced),
  }));
}
