import { type SpendRecord, setSpendSink } from '@repo/ai/spend';
import { recordModelSpend, summarizeModelSpend } from '@repo/db/queries';
import { z } from 'zod';
import logger, { threadLogContext } from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Hack Club's price for Jev (hackclub/ai src/gateway/routes/jev.ts): input
// tokens only, output free.
const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPEND_DAYS = 90;

function save(record: SpendRecord): void {
  recordModelSpend({
    ...record,
    // Every turn (and what it starts, subagents included) runs inside the
    // thread's log context; background work outside one is filed thread-less.
    threadId: threadLogContext.getStore()?.threadId ?? null,
  }).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), source: record.source },
      '[spend] could not record a model call'
    );
  });
}

/** Every model call from here on lands in `model_spend`. */
export function startSpendLedger(): void {
  setSpendSink(save);
}

const jevUsageSchema = z.object({
  usage: z.object({ input_tokens: z.number() }),
});

/** A Jev response's bill. `source` names the question it answered. */
export function recordJevSpend({
  body,
  source,
}: {
  body: unknown;
  source: string;
}): void {
  const parsed = jevUsageSchema.safeParse(body);
  if (!parsed.success) {
    return;
  }
  const inputTokens = parsed.data.usage.input_tokens;
  save({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: inputTokens * JEV_INPUT_USD_PER_TOKEN,
    effort: null,
    inputTokens,
    model: 'jev',
    outputTokens: 0,
    provider: 'hackclub',
    source,
  });
}

const openRouterUsageSchema = z.object({
  usage: z.object({
    completion_tokens: z.number().optional(),
    cost: z.number().optional(),
    cost_details: z
      .object({ upstream_inference_cost: z.number().optional() })
      .optional(),
    prompt_tokens: z.number().optional(),
  }),
});

/**
 * The bill of a raw chat-completions call made outside `streamAttempt` (image
 * generation). Same reading as stepsCostUsd: on a BYOK route `cost` is 0 and
 * the real figure is the upstream one.
 */
export function recordCompletionSpend({
  body,
  model,
  source,
}: {
  body: unknown;
  model: string;
  source: string;
}): void {
  const usage = openRouterUsageSchema.safeParse(body).data?.usage;
  if (!usage) {
    return;
  }
  const upstream = usage.cost_details?.upstream_inference_cost;
  save({
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usage.cost || upstream || (usage.cost ?? null),
    effort: null,
    inputTokens: usage.prompt_tokens ?? 0,
    model,
    outputTokens: usage.completion_tokens ?? 0,
    provider: 'hackclub',
    source,
  });
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
}

/**
 * `!spend [days]` (owner only): the bill since UTC midnight `days - 1` days
 * ago, by what spent it and by model/effort. Given a `threadId` (the command
 * was a reply in a thread), that thread's whole bill instead — everything run
 * in it, subagents, Kevinton's review and compaction included.
 */
export async function describeSpend({
  args,
  threadId,
}: {
  args: string;
  threadId?: string;
}): Promise<string> {
  const requested = Number.parseInt(args.trim(), 10);
  const days =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_SPEND_DAYS)
      : 1;
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const since = threadId
    ? undefined
    : new Date(midnight.getTime() - (days - 1) * DAY_MS);
  const groups = await summarizeModelSpend({ since, threadId });
  const scope = since
    ? `since ${since.toISOString().slice(0, 10)} UTC`
    : 'in this thread';
  if (groups.length === 0) {
    return `nothing recorded ${scope} (the ledger started 2026-10-11).`;
  }
  const total = groups.reduce((sum, group) => sum + group.costUsd, 0);
  const bySource = new Map<string, { calls: number; cost: number }>();
  for (const group of groups) {
    const entry = bySource.get(group.source) ?? { calls: 0, cost: 0 };
    entry.calls += group.calls;
    entry.cost += group.costUsd;
    bySource.set(group.source, entry);
  }
  const sources = [...bySource.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([source, entry]) =>
        `• ${source}: ${usd(entry.cost)} (${entry.calls} calls)`
    );
  const models = [...groups]
    .sort((a, b) => b.costUsd - a.costUsd)
    .map((group) => {
      const hit =
        group.inputTokens > 0
          ? Math.round((100 * group.cacheReadTokens) / group.inputTokens)
          : 0;
      const unpriced = group.unpriced > 0 ? `, ${group.unpriced} unpriced` : '';
      return `• ${group.source} · ${group.model}${group.effort ? ` · ${group.effort}` : ''}: ${usd(group.costUsd)} — ${group.calls} calls, ${Math.round(group.inputTokens / 1000)}k in (${hit}% cached, ${Math.round(group.cacheWriteTokens / 1000)}k written), ${Math.round(group.outputTokens / 1000)}k out${unpriced}`;
    });
  return [
    `*${usd(total)}* at list price ${scope} (Hack Club's 30% Claude discount is applied on its side and not shown).`,
    '*by source*',
    ...sources,
    '*by source, model and effort*',
    ...models,
  ].join('\n');
}
