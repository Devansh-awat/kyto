import { LUNA_MODEL, PRIMARY_MODEL } from '@repo/ai';
import { type SpendRecord, setSpendSink } from '@repo/ai/spend';
import {
  callStats,
  recordModelSpend,
  type SpendGroup,
  summarizeModelSpend,
} from '@repo/db/queries';
import { z } from 'zod';
import { timeUntilUtcMidnight } from '@/lib/errors';
import logger, { threadLogContext } from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Hack Club's price for Jev (hackclub/ai src/gateway/routes/jev.ts): input
// tokens only, output free.
const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
// Hack Club takes 30% off a Claude request only when Anthropic served it
// (hackclub/ai `src/billing/discounts.ts`); every anthropic/* request kyto sends
// is pinned there (`ANTHROPIC_ONLY_MODELS`), and `costUsd` is list price.
const HACKCLUB_CLAUDE_DISCOUNT = 0.3;
// Hack Club's default daily allowance, counted over the UTC day.
const HACKCLUB_DAILY_USD = 3;
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
    reasoningTokens: 0,
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
    reasoningTokens: 0,
    source,
  });
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
}

/**
 * Who paid: kyto's own Hack Club key (the one with the daily limit), someone's
 * own key (`byok:*` — their money, not kyto's budget), or another of kyto's
 * providers (Gemini for compaction). Summing all three as one figure made
 * `!spend` read ~4x Hack Club's dashboard on a day one person coded on their key.
 */
function payerOf(provider: string): 'kyto' | 'own' | 'other' {
  if (provider === 'hackclub') {
    return 'kyto';
  }
  return provider.startsWith('byok:') ? 'own' : 'other';
}

/** What Hack Club's dashboard counts: list price, less its Claude discount. */
function hackclubBilled(group: SpendGroup): number {
  return group.model.startsWith('anthropic/')
    ? group.costUsd * (1 - HACKCLUB_CLAUDE_DISCOUNT)
    : group.costUsd;
}

function describeGroups(groups: SpendGroup[]): string[] {
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
      const provider =
        payerOf(group.provider) === 'kyto' ? '' : ` · ${group.provider}`;
      return `• ${group.source} · ${group.model}${group.effort ? ` · ${group.effort}` : ''}${provider}: ${usd(group.costUsd)} — ${group.calls} calls, ${Math.round(group.inputTokens / 1000)}k in (${hit}% cached, ${Math.round(group.cacheWriteTokens / 1000)}k written), ${Math.round(group.outputTokens / 1000)}k out${unpriced}`;
    });
  return [
    '*by source*',
    ...sources,
    '*by source, model and effort*',
    ...models,
  ];
}

/**
 * `!spend [days]` (owner only): the bill since UTC midnight `days - 1` days
 * ago — Hack Club's own day — split by whose key paid, then by what spent it
 * and by model/effort. Given a `threadId` (the command was a reply in a
 * thread), that thread's whole bill instead — everything run in it, subagents,
 * Kevinton's review and compaction included.
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
  const kyto = groups.filter((group) => payerOf(group.provider) === 'kyto');
  const own = groups.filter((group) => payerOf(group.provider) === 'own');
  const other = groups.filter((group) => payerOf(group.provider) === 'other');
  const sum = (list: SpendGroup[], price: (group: SpendGroup) => number) =>
    list.reduce((total, group) => total + price(group), 0);
  const listPrice = sum(kyto, (group) => group.costUsd);
  const billed = sum(kyto, hackclubBilled);
  const { hours, minutes } = timeUntilUtcMidnight();
  const limit =
    since && days === 1
      ? ` of Hack Club's $${HACKCLUB_DAILY_USD}/day (resets at UTC midnight, in ${hours}h ${minutes}m)`
      : '';
  const lines = [
    `*≈${usd(billed)}* on kyto's Hack Club key ${scope}${limit} — ${usd(listPrice)} at list price, less Hack Club's ${HACKCLUB_CLAUDE_DISCOUNT * 100}% off Claude.`,
    ...describeGroups(kyto),
  ];
  if (own.length > 0) {
    lines.push(
      '',
      `*${usd(sum(own, (group) => group.costUsd))}* on people's own keys — their money, not kyto's budget.`,
      ...describeGroups(own)
    );
  }
  if (other.length > 0) {
    lines.push(
      '',
      `*${usd(sum(other, (group) => group.costUsd))}* on kyto's other providers.`,
      ...describeGroups(other)
    );
  }
  return lines.join('\n');
}

const DEFAULT_EFFORT_DAYS = 7;
const EFFORT_MODELS = [PRIMARY_MODEL, LUNA_MODEL];
const EFFORTS = ['low', 'medium', 'high'];
const MS_PER_SECOND = 1000;
const PERCENT = 100;

/**
 * `!effort [days] [source]` (owner only, 2026-10-17): haiku and luna at each
 * effort, over every model call (turns, subagents, Kevinton, reminders, the
 * digest, …; `source` keeps one), from the per-step stats each call records.
 * The answer in tokens, chars and words side by side (the two tokenizers
 * differ); thinking in tokens and time only, since its text is a summary.
 */
export async function describeEffortStats(args: string): Promise<string> {
  const days = Math.min(
    Math.max(Number(args.match(/\d+/)?.[0]) || DEFAULT_EFFORT_DAYS, 1),
    MAX_SPEND_DAYS
  );
  const source = args.match(/[a-z][a-z-]*/)?.[0];
  const cells = await callStats({
    efforts: EFFORTS,
    models: EFFORT_MODELS,
    since: new Date(Date.now() - days * DAY_MS),
    ...(source ? { source } : {}),
  });
  const scope = `last ${days} day${days === 1 ? '' : 's'}${source ? `, ${source} only` : ', every source'}`;
  if (cells.length === 0) {
    return `No measured haiku or luna calls in the ${scope} (calls are measured from 2026-10-17).`;
  }
  const f = (value: number | null, digits = 0) =>
    value === null ? '?' : value.toFixed(digits);
  const s = (ms: number | null) =>
    ms === null ? '?' : `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  const lines = cells.map((cell) => {
    const call = cell.perCall;
    const step = cell.perThinkingStep;
    return [
      `*${cell.model.split('/').at(-1)} · ${cell.effort}*: ${cell.calls} calls, ${cell.steps} steps (${cell.sources.map((entry) => `${entry.source} ${entry.calls}`).join(', ')})`,
      `  cost: $${f(cell.costPerCall, 4)}/call, $${f(cell.costTotal, 3)} total · ${f(cell.cacheReadShare === null ? null : cell.cacheReadShare * PERCENT)}% of input cached`,
      `  time: call median ${s(cell.medianCallMs)} (p90 ${s(cell.p90CallMs)}) · ${f(cell.stepsPerCall, 1)} steps/call · step median ${s(cell.medianStepMs)} (p90 ${s(cell.p90StepMs)}) · first token ${s(cell.medianTtftMs)} · before answering ${s(cell.medianThinkMs)}`,
      `  thinking: ${cell.thinkingSteps} of ${cell.steps} steps · ${f(cell.reasoningShare === null ? null : cell.reasoningShare * PERCENT)}% of output · ${f(call.reasoningTokens)} tokens per call, ${f(step.reasoningTokens)} per thinking step`,
      `  thinking speed: ${f(cell.thinkTokensPerSecond)} tokens/s before the answer (prefill included)`,
      `  answer: per call ${f(call.textTokens)} tokens / ${f(call.textChars)} chars / ${f(call.textWords)} words of text, tool calls ${f(call.toolInputChars)} chars / ${f(call.toolInputWords)} words · ${f(cell.answerCharsPerToken, 2)} chars and ${f(cell.answerWordsPerToken, 2)} words per answer token`,
      `  answer speed: ${f(cell.answerTokensPerSecond)} tokens/s, ${f(cell.answerCharsPerSecond)} chars/s, ${f(cell.answerWordsPerSecond, 1)} words/s`,
    ].join('\n');
  });
  return `*Haiku vs luna by effort, ${scope}* (list prices; haiku costs 30% less on Hack Club)\n${lines.join('\n')}`;
}
