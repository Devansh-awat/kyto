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

/**
 * One user's shared-key (Hack Club) spend since a cutoff, for the per-user
 * daily cap. Only `provider = 'hackclub'` is the shared budget — a user's own
 * `byok:*` key and the free Gemini floor are theirs / free and don't count.
 */
export async function sumUserSharedSpendSince(
  userId: string,
  since: Date
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${modelSpend.costUsd}), 0)`,
    })
    .from(modelSpend)
    .where(
      and(
        eq(modelSpend.userId, userId),
        eq(modelSpend.provider, 'hackclub'),
        gte(modelSpend.createdAt, since)
      )
    );
  return Number(row?.total ?? 0);
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
// Input-processing speed needs enough new input to time: a 40-token step's
// first token is all network.
const MIN_PREFILL_TOKENS = 1000;

/** Medians of one kind of request (a call's first, or every later one). */
export interface RequestMedians {
  inputTokens: number | null;
  ms: number | null;
  thinkMs: number | null;
  ttftMs: number | null;
  /** Input not read from cache: what the model had to process fresh. */
  uncachedTokens: number | null;
}

/** One model × effort cell of `!effort`, from every call's `stats`. */
export interface CallStatsCell {
  /** Calls a stop, the watchdog or an interrupt ended mid-request. */
  abortedCalls: number;
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
  /** Calls a request error ended. */
  erroredCalls: number;
  /** What failed requests died of (`name status`), most first. */
  errors: { count: number; error: string }[];
  /** Every request's finish reason, most first. */
  finishReasons: { count: number; reason: string }[];
  firstRequest: RequestMedians;
  laterRequests: RequestMedians;
  /** Time (ms) per call and per step: FINISHED ones only. */
  medianCallMs: number | null;
  medianStepMs: number | null;
  model: string;
  p90CallMs: number | null;
  p90StepMs: number | null;
  /** Per FINISHED call (cost per call counts failed ones: they're paid). */
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
  /**
   * First-token time per 1000 uncached input tokens, over steps that did no
   * thinking (so the wait is input processing, not thought).
   */
  prefillMsPer1k: number | null;
  prefillSteps: number;
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
 * side, thinking in tokens and time only (its text is a summary). A call's
 * first request is apart from its later ones (its whole prompt is new input;
 * later steps add a tool result to a cached one), and failed requests are
 * counted but kept out of the times.
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
  // Null when absent (calls recorded before the field existed), which the
  // medians skip instead of counting as zero.
  const v = (field: string) => sql.raw(`(e->>'${field}')::float`);
  // A request that finished: failed ones are counted, never timed.
  const okText = `coalesce(e->>'finishReason', '') not in ('error', 'aborted')`;
  const ok = sql.raw(okText);
  const uncached = sql.raw(
    `((e->>'inputTokens')::float - coalesce((e->>'cacheReadTokens')::float, 0))`
  );
  // A rate over a window this short is a buffered burst, not a speed.
  const answerWindow = sql.raw(
    `${okText} and e ? 'thinkMs' and (e->>'ms')::float - (e->>'thinkMs')::float >= ${MIN_RATE_WINDOW_MS}`
  );
  const prefill = sql.raw(
    `${okText} and e ? 'ttftMs' and coalesce((e->>'reasoningTokens')::float, 0) = 0 and (e->>'inputTokens')::float - coalesce((e->>'cacheReadTokens')::float, 0) >= ${MIN_PREFILL_TOKENS}`
  );
  const medians = (prefix: string, where: string) =>
    sql.raw(`
        percentile_cont(0.5) within group (order by (e->>'inputTokens')::float) filter (where ${where}) as ${prefix}_input,
        percentile_cont(0.5) within group (order by (e->>'inputTokens')::float - coalesce((e->>'cacheReadTokens')::float, 0)) filter (where ${where}) as ${prefix}_uncached,
        percentile_cont(0.5) within group (order by (e->>'ttftMs')::float) filter (where ${where}) as ${prefix}_ttft,
        percentile_cont(0.5) within group (order by (e->>'thinkMs')::float) filter (where ${where}) as ${prefix}_think,
        percentile_cont(0.5) within group (order by (e->>'ms')::float) filter (where ${where}) as ${prefix}_ms,`);
  const rows = await db.execute<Record<string, string | number | null>>(sql`
    with c as (
      select ms.id, ms.model, ms.effort, ms.cost_usd, ms.input_tokens,
        ms.cache_read_tokens,
        (select sum((e->>'ms')::float) from jsonb_array_elements(ms.stats->'steps') e) as call_ms,
        jsonb_array_length(ms.stats->'steps') as steps,
        exists (select 1 from jsonb_array_elements(ms.stats->'steps') e where e->>'finishReason' = 'error') as errored,
        exists (select 1 from jsonb_array_elements(ms.stats->'steps') e where e->>'finishReason' = 'aborted') as aborted
      from model_spend ms where ${filter}
    ),
    s as (
      select ms.id, ms.model, ms.effort, x.e, x.idx,
        not (c.errored or c.aborted) as finished
      from model_spend ms
        join c using (id),
        jsonb_array_elements(ms.stats->'steps') with ordinality as x(e, idx)
      where ${filter}
    ),
    calls as (
      select model, effort, count(*)::int as calls,
        count(*) filter (where errored)::int as errored_calls,
        count(*) filter (where aborted and not errored)::int as aborted_calls,
        avg(cost_usd) as cost_per_call, sum(cost_usd) as cost_total,
        sum(cache_read_tokens)::float / nullif(sum(input_tokens), 0) as cache_read_share,
        percentile_cont(0.5) within group (order by call_ms) filter (where not errored and not aborted) as median_call_ms,
        percentile_cont(0.9) within group (order by call_ms) filter (where not errored and not aborted) as p90_call_ms,
        avg(steps) as steps_per_call,
        count(*) filter (where not errored and not aborted)::int as finished_calls
      from c group by 1, 2
    ),
    steps as (
      select model, effort, count(*)::int as steps,
        count(*) filter (where ${n('reasoningTokens')} > 0)::int as thinking_steps,
        percentile_cont(0.5) within group (order by ${v('ms')}) filter (where ${ok}) as median_step_ms,
        percentile_cont(0.9) within group (order by ${v('ms')}) filter (where ${ok}) as p90_step_ms,
        ${medians('first', `idx = 1 and ${okText}`)}
        ${medians('later', `idx > 1 and ${okText}`)}
        sum(${v('ttftMs')}) filter (where ${prefill})
          * 1000 / nullif(sum(${uncached}) filter (where ${prefill}), 0) as prefill_ms_per_1k,
        count(*) filter (where ${prefill})::int as prefill_steps,
        sum(${n('reasoningTokens')}) as reasoning_tokens,
        sum(${n('reasoningTokens')}) filter (where finished) as finished_reasoning_tokens,
        sum(${n('textTokens')}) filter (where finished) as finished_text_tokens,
        sum(${n('textChars')}) filter (where finished) as finished_text_chars,
        sum(${n('textWords')}) filter (where finished) as finished_text_words,
        sum(${n('toolInputChars')}) filter (where finished) as finished_tool_input_chars,
        sum(${n('toolInputWords')}) filter (where finished) as finished_tool_input_words,
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
    per_reason as (
      select model, effort, coalesce(e->>'finishReason', 'unknown') as reason, count(*)::int as n
      from s group by 1, 2, 3
    ),
    reasons as (
      select model, effort,
        jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc) as finish_reasons
      from per_reason group by 1, 2
    ),
    per_error as (
      select model, effort, e->>'error' as error, count(*)::int as n
      from s where e ? 'error' group by 1, 2, 3
    ),
    errors as (
      select model, effort,
        jsonb_agg(jsonb_build_object('error', error, 'count', n) order by n desc) as errors
      from per_error group by 1, 2
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
      join reasons using (model, effort)
      left join errors using (model, effort)
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
  const request = (
    row: Record<string, string | number | null>,
    prefix: string
  ) => ({
    inputTokens: num(row[`${prefix}_input`]),
    ms: num(row[`${prefix}_ms`]),
    thinkMs: num(row[`${prefix}_think`]),
    ttftMs: num(row[`${prefix}_ttft`]),
    uncachedTokens: num(row[`${prefix}_uncached`]),
  });
  const sourceSchema = z.array(
    z.object({ calls: z.number(), source: z.string() })
  );
  const reasonSchema = z.array(
    z.object({ count: z.number(), reason: z.string() })
  );
  const errorSchema = z.array(
    z.object({ count: z.number(), error: z.string() })
  );
  return rows.map((row) => {
    const calls = Number(row.calls);
    const finishedCalls = Number(row.finished_calls);
    const thinkingSteps = Number(row.thinking_steps);
    return {
      abortedCalls: Number(row.aborted_calls),
      answerCharsPerSecond: num(row.answer_chars_per_second),
      answerCharsPerToken: ratio(
        (num(row.text_chars) ?? 0) + (num(row.tool_input_chars) ?? 0),
        row.text_tokens
      ),
      answerTokensPerSecond: num(row.answer_tokens_per_second),
      answerWordsPerSecond: num(row.answer_words_per_second),
      answerWordsPerToken: ratio(
        (num(row.text_words) ?? 0) + (num(row.tool_input_words) ?? 0),
        row.text_tokens
      ),
      cacheReadShare: num(row.cache_read_share),
      calls,
      costPerCall: num(row.cost_per_call),
      costTotal: num(row.cost_total),
      effort: String(row.effort),
      erroredCalls: Number(row.errored_calls),
      errors: errorSchema.catch([]).parse(row.errors ?? []),
      finishReasons: reasonSchema.catch([]).parse(row.finish_reasons ?? []),
      firstRequest: request(row, 'first'),
      laterRequests: request(row, 'later'),
      medianCallMs: num(row.median_call_ms),
      medianStepMs: num(row.median_step_ms),
      model: String(row.model),
      p90CallMs: num(row.p90_call_ms),
      p90StepMs: num(row.p90_step_ms),
      perCall: {
        reasoningTokens: per(row.finished_reasoning_tokens, finishedCalls),
        textChars: per(row.finished_text_chars, finishedCalls),
        textTokens: per(row.finished_text_tokens, finishedCalls),
        textWords: per(row.finished_text_words, finishedCalls),
        toolInputChars: per(row.finished_tool_input_chars, finishedCalls),
        toolInputWords: per(row.finished_tool_input_words, finishedCalls),
      },
      perThinkingStep: {
        reasoningTokens: per(row.reasoning_tokens, thinkingSteps),
      },
      prefillMsPer1k: num(row.prefill_ms_per_1k),
      prefillSteps: Number(row.prefill_steps),
      reasoningShare: ratio(row.reasoning_tokens, row.output_tokens),
      sources: sourceSchema.catch([]).parse(row.sources ?? []),
      steps: Number(row.steps),
      stepsPerCall: num(row.steps_per_call),
      thinkTokensPerSecond: num(row.think_tokens_per_second),
      thinkingSteps,
    };
  });
}
