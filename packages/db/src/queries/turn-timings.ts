import { desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../client';
import { type TurnTiming, turnTimings } from '../schema';

export type { TurnTiming } from '../schema';

export async function recordTurnTiming(
  row: Omit<TurnTiming, 'createdAt' | 'id'>
): Promise<void> {
  await db.insert(turnTimings).values(row);
}

/** A thread's most recent turns, newest first. */
export async function listTurnTimings({
  limit,
  threadId,
}: {
  limit: number;
  threadId: string;
}): Promise<TurnTiming[]> {
  return await db
    .select()
    .from(turnTimings)
    .where(eq(turnTimings.threadId, threadId))
    .orderBy(desc(turnTimings.createdAt))
    .limit(limit);
}

export async function pruneTurnTimings(olderThan: Date): Promise<void> {
  await db.delete(turnTimings).where(lt(turnTimings.createdAt, olderThan));
}

/** One model × effort cell of the effort experiment (`!effort`). */
export interface EffortCell {
  avgCostUsd: number | null;
  /** Reasoning characters per thinking block. */
  charsPerBlock: number | null;
  /** Reasoning characters per reasoning token: ~4 = full text streamed. */
  charsPerToken: number | null;
  down: number;
  /** Turns whose effort was the random draw; the rest were chosen. */
  drawn: number;
  effort: string;
  medianModelMs: number | null;
  medianTotalMs: number | null;
  model: string;
  p90TotalMs: number | null;
  /** Reasoning characters per second, over blocks that streamed. */
  reasoningCharsPerSecond: number | null;
  /** Thinking tokens over all output tokens. */
  reasoningShare: number | null;
  replyChars: number | null;
  steps: number | null;
  /** Request out → answer starts, per thinking step. */
  thinkMsPerStep: number | null;
  tokensPerThinkingStep: number | null;
  tokensPerThinkSecond: number | null;
  tokensPerTurn: number | null;
  turns: number;
  up: number;
}

/**
 * The effort experiment by model × effort since `since`, from what each turn
 * saved (lib/ai/stream/timing). Drawn and chosen efforts (`--reasoning`,
 * `--model`) are counted together, with how many were drawn. A 👍/👎 counts
 * against the turn whose reply it was left on: same thread, posted between
 * that turn's message and its end.
 */
export async function effortStats({
  since,
}: {
  since: Date;
}): Promise<EffortCell[]> {
  const rows = await db.execute<Record<string, string | number | null>>(sql`
    with t as (
      select tt.*, tt.timing->'reasoning' as r
      from turn_timings tt
      where tt.outcome = 'complete'
        and tt.created_at >= ${since.toISOString()}::timestamptz
        and tt.timing->>'answeredBy' is not null
    ),
    f as (
      select t.id,
        count(*) filter (where rf.rating = 'up') as up,
        count(*) filter (where rf.rating = 'down') as down
      from t join reply_feedback rf
        on rf.thread_id = t.thread_id
        and rf.message_ts::numeric >= t.message_ts::numeric
        and rf.message_ts::numeric <= extract(epoch from t.created_at) + 5
      group by t.id
    )
    select
      t.timing->>'answeredBy' as model,
      coalesce(t.timing->>'reasoningEffort', '(none)') as effort,
      count(*)::int as turns,
      count(*) filter (where (t.timing->>'reasoningRandom')::boolean)::int as drawn,
      percentile_cont(0.5) within group (order by t.total_ms) as median_total_ms,
      percentile_cont(0.9) within group (order by t.total_ms) as p90_total_ms,
      percentile_cont(0.5) within group (order by (t.timing->>'modelMs')::float) as median_model_ms,
      avg((t.timing->>'costUsd')::float) as avg_cost_usd,
      avg((t.r->>'steps')::float) as steps,
      avg((t.r->>'tokens')::float) as tokens_per_turn,
      sum((t.r->>'tokens')::float) / nullif(sum((t.r->>'thinkingSteps')::float), 0) as tokens_per_thinking_step,
      sum((t.r->>'tokens')::float) * 1000 / nullif(sum((t.r->>'thinkMs')::float), 0) as tokens_per_think_second,
      sum((t.r->>'thinkMs')::float) / nullif(sum((t.r->>'thinkingSteps')::float), 0) as think_ms_per_step,
      sum((t.r->>'chars')::float) / nullif(sum((t.r->>'blocks')::float), 0) as chars_per_block,
      sum((t.r->>'chars')::float) / nullif(sum((t.r->>'tokens')::float), 0) as chars_per_token,
      sum((t.r->>'streamedChars')::float) * 1000 / nullif(sum((t.r->>'streamedMs')::float), 0) as reasoning_chars_per_second,
      sum((t.r->>'tokens')::float) / nullif(sum((t.r->>'outputTokens')::float), 0) as reasoning_share,
      avg((t.r->>'textChars')::float) as reply_chars,
      coalesce(sum(f.up), 0)::int as up,
      coalesce(sum(f.down), 0)::int as down
    from t left join f on f.id = t.id
    group by 1, 2
    order by 1, 2
  `);
  const num = (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : Number(value);
  return rows.map((row) => ({
    avgCostUsd: num(row.avg_cost_usd),
    charsPerBlock: num(row.chars_per_block),
    charsPerToken: num(row.chars_per_token),
    down: Number(row.down),
    drawn: Number(row.drawn),
    effort: String(row.effort),
    medianModelMs: num(row.median_model_ms),
    medianTotalMs: num(row.median_total_ms),
    model: String(row.model),
    p90TotalMs: num(row.p90_total_ms),
    reasoningCharsPerSecond: num(row.reasoning_chars_per_second),
    reasoningShare: num(row.reasoning_share),
    replyChars: num(row.reply_chars),
    steps: num(row.steps),
    thinkMsPerStep: num(row.think_ms_per_step),
    tokensPerThinkSecond: num(row.tokens_per_think_second),
    tokensPerThinkingStep: num(row.tokens_per_thinking_step),
    tokensPerTurn: num(row.tokens_per_turn),
    turns: Number(row.turns),
    up: Number(row.up),
  }));
}
