import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../client';
import { type ModelSpend, modelSpend } from '../schema';

export type { ModelSpend } from '../schema';

export async function recordModelSpend(
  row: Omit<ModelSpend, 'createdAt' | 'id' | 'reasoningTokens' | 'stats'> & {
    reasoningTokens?: number;
    stats?: ModelSpend['stats'];
  }
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
  provider: string;
  source: string;
  unpriced: number;
}

/**
 * Spend since `since` (all of it when omitted), optionally in one thread only,
 * grouped by what spent it, whose key paid (provider), model and effort.
 */
export async function summarizeModelSpend({
  since,
  threadId,
}: {
  since?: Date;
  threadId?: string;
}): Promise<SpendGroup[]> {
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
      provider: modelSpend.provider,
      source: modelSpend.source,
      unpriced: sql<string>`count(*) filter (where ${modelSpend.costUsd} is null)`,
    })
    .from(modelSpend)
    .where(
      and(
        since ? gte(modelSpend.createdAt, since) : undefined,
        threadId ? eq(modelSpend.threadId, threadId) : undefined
      )
    )
    .groupBy(
      modelSpend.source,
      modelSpend.provider,
      modelSpend.model,
      modelSpend.effort
    );
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
    provider: row.provider,
    source: row.source,
    unpriced: Number(row.unpriced),
  }));
}

const MIN_RATE_WINDOW_MS = 500;

/** One model × effort cell of `!effort`, from every call's `stats`. */
export interface CallStatsCell {
  /** Answer (reply text + tool calls) per second, after the thinking. */
  answerCharsPerSecond: number | null;
  /**
   * Answer (reply text + tool-call input) chars and words per non-thinking
   * output token: tool calls are part of those tokens too.
   */
  answerCharsPerToken: number | null;
  answerTokensPerSecond: number | null;
  answerWordsPerSecond: number | null;
  answerWordsPerToken: number | null;
  cacheReadShare: number | null;
  calls: number;
  costPerCall: number | null;
  costTotal: number | null;
  effort: string;
  medianCallMs: number | null;
  medianStepMs: number | null;
  medianThinkMs: number | null;
  medianTtftMs: number | null;
  model: string;
  p90CallMs: number | null;
  p90StepMs: number | null;
  /** Per call. */
  perCall: {
    reasoningTokens: number | null;
    textChars: number | null;
    textTokens: number | null;
    textWords: number | null;
    toolInputChars: number | null;
    toolInputWords: number | null;
  };
  /** Per THINKING step. */
  perThinkingStep: {
    reasoningTokens: number | null;
  };
  /** Thinking tokens over all output tokens. */
  reasoningShare: number | null;
  /** Calls per source, most first. */
  sources: { calls: number; source: string }[];
  steps: number;
  stepsPerCall: number | null;
  /** Steps that thought at all. */
  thinkingSteps: number;
  /** Thinking tokens over the time before the answer started (prefill too). */
  thinkTokensPerSecond: number | null;
}

/**
 * The model × effort comparison (`!effort`, owner's ask 2026-10-17): every
 * source's calls since `since`, from the per-step `stats` each call records
 * (@repo/ai call-stats): the answer in tokens, characters and words side by
 * side, thinking in tokens and time only (its text is a summary).
 */
export async function callStats({
  efforts,
  models,
  since,
  source,
}: {
  efforts: string[];
  models: string[];
  since: Date;
  source?: string;
}): Promise<CallStatsCell[]> {
  const filter = sql`ms.created_at >= ${since.toISOString()}::timestamptz
    and ms.stats is not null
    and ms.model in (${sql.join(
      models.map((model) => sql`${model}`),
      sql`, `
    )})
    and ms.effort in (${sql.join(
      efforts.map((effort) => sql`${effort}`),
      sql`, `
    )})
    ${source ? sql`and ms.source = ${source}` : sql``}`;
  const n = (field: string) => sql.raw(`coalesce((e->>'${field}')::float, 0)`);
  // A rate over a window this short is a buffered burst, not a speed.
  const answerWindow = sql.raw(
    `e ? 'thinkMs' and (e->>'ms')::float - (e->>'thinkMs')::float >= ${MIN_RATE_WINDOW_MS}`
  );
  const rows = await db.execute<Record<string, string | number | null>>(sql`
    with c as (
      select ms.model, ms.effort, ms.cost_usd, ms.input_tokens,
        ms.cache_read_tokens,
        (select sum((e->>'ms')::float) from jsonb_array_elements(ms.stats->'steps') e) as call_ms,
        jsonb_array_length(ms.stats->'steps') as steps
      from model_spend ms where ${filter}
    ),
    s as (
      select ms.model, ms.effort, e
      from model_spend ms, jsonb_array_elements(ms.stats->'steps') e
      where ${filter}
    ),
    calls as (
      select model, effort, count(*)::int as calls,
        avg(cost_usd) as cost_per_call, sum(cost_usd) as cost_total,
        sum(cache_read_tokens)::float / nullif(sum(input_tokens), 0) as cache_read_share,
        percentile_cont(0.5) within group (order by call_ms) as median_call_ms,
        percentile_cont(0.9) within group (order by call_ms) as p90_call_ms,
        avg(steps) as steps_per_call
      from c group by 1, 2
    ),
    steps as (
      select model, effort, count(*)::int as steps,
        count(*) filter (where ${n('reasoningTokens')} > 0)::int as thinking_steps,
        percentile_cont(0.5) within group (order by (e->>'ms')::float) as median_step_ms,
        percentile_cont(0.9) within group (order by (e->>'ms')::float) as p90_step_ms,
        percentile_cont(0.5) within group (order by (e->>'ttftMs')::float) as median_ttft_ms,
        percentile_cont(0.5) within group (order by (e->>'thinkMs')::float) as median_think_ms,
        sum(${n('reasoningTokens')}) as reasoning_tokens,
        sum(${n('textTokens')}) as text_tokens,
        sum(${n('textChars')}) as text_chars,
        sum(${n('textWords')}) as text_words,
        sum(${n('toolInputChars')}) as tool_input_chars,
        sum(${n('toolInputWords')}) as tool_input_words,
        sum(${n('outputTokens')}) as output_tokens,
        sum(${n('reasoningTokens')}) filter (where e ? 'thinkMs')
          * 1000 / nullif(sum(${n('thinkMs')}) filter (where e ? 'thinkMs' and ${n('reasoningTokens')} > 0), 0) as think_tokens_per_second,
        sum(${n('outputTokens')} - ${n('reasoningTokens')}) filter (where ${answerWindow})
          * 1000 / nullif(sum(${n('ms')} - ${n('thinkMs')}) filter (where ${answerWindow}), 0) as answer_tokens_per_second,
        sum(${n('textChars')} + ${n('toolInputChars')}) filter (where ${answerWindow})
          * 1000 / nullif(sum(${n('ms')} - ${n('thinkMs')}) filter (where ${answerWindow}), 0) as answer_chars_per_second,
        sum(${n('textWords')} + ${n('toolInputWords')}) filter (where ${answerWindow})
          * 1000 / nullif(sum(${n('ms')} - ${n('thinkMs')}) filter (where ${answerWindow}), 0) as answer_words_per_second
      from s group by 1, 2
    ),
    per_source as (
      select model, effort, source, count(*)::int as calls
      from model_spend ms where ${filter} group by 1, 2, 3
    ),
    sources as (
      select model, effort,
        jsonb_agg(jsonb_build_object('source', source, 'calls', calls) order by calls desc) as sources
      from per_source group by 1, 2
    )
    select * from calls
      join steps using (model, effort)
      join sources using (model, effort)
    order by model, array_position(array['none', 'low', 'medium', 'high'], effort)
  `);
  const num = (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : Number(value);
  const per = (value: string | number | null | undefined, count: number) =>
    count > 0 ? (num(value) ?? 0) / count : null;
  const ratio = (
    top: string | number | null | undefined,
    bottom: string | number | null | undefined
  ) => {
    const below = num(bottom);
    return below ? (num(top) ?? 0) / below : null;
  };
  const sourceSchema = z.array(
    z.object({ calls: z.number(), source: z.string() })
  );
  return rows.map((row) => {
    const calls = Number(row.calls);
    const thinkingSteps = Number(row.thinking_steps);
    return {
      answerCharsPerSecond: num(row.answer_chars_per_second),
      answerTokensPerSecond: num(row.answer_tokens_per_second),
      answerWordsPerSecond: num(row.answer_words_per_second),
      cacheReadShare: num(row.cache_read_share),
      calls,
      costPerCall: num(row.cost_per_call),
      costTotal: num(row.cost_total),
      effort: String(row.effort),
      medianCallMs: num(row.median_call_ms),
      medianStepMs: num(row.median_step_ms),
      medianThinkMs: num(row.median_think_ms),
      medianTtftMs: num(row.median_ttft_ms),
      model: String(row.model),
      p90CallMs: num(row.p90_call_ms),
      p90StepMs: num(row.p90_step_ms),
      perCall: {
        reasoningTokens: per(row.reasoning_tokens, calls),
        textChars: per(row.text_chars, calls),
        textTokens: per(row.text_tokens, calls),
        textWords: per(row.text_words, calls),
        toolInputChars: per(row.tool_input_chars, calls),
        toolInputWords: per(row.tool_input_words, calls),
      },
      perThinkingStep: {
        reasoningTokens: per(row.reasoning_tokens, thinkingSteps),
      },
      reasoningShare: ratio(row.reasoning_tokens, row.output_tokens),
      sources: sourceSchema.catch([]).parse(row.sources ?? []),
      steps: Number(row.steps),
      stepsPerCall: num(row.steps_per_call),
      answerCharsPerToken: ratio(
        (num(row.text_chars) ?? 0) + (num(row.tool_input_chars) ?? 0),
        row.text_tokens
      ),
      answerWordsPerToken: ratio(
        (num(row.text_words) ?? 0) + (num(row.tool_input_words) ?? 0),
        row.text_tokens
      ),
      thinkTokensPerSecond: num(row.think_tokens_per_second),
      thinkingSteps,
    };
  });
}
