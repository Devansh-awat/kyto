import { z } from 'zod';

// OpenRouter's raw usage, as the Hack Club proxy passes it through. Only the
// fields the bill is read from.
const rawUsage = z.object({
  cost: z.number().optional(),
  cost_details: z
    .object({ upstream_inference_cost: z.number().optional() })
    .optional(),
  is_byok: z.boolean().optional(),
  prompt_tokens_details: z
    .object({ cache_write_tokens: z.number().optional() })
    .optional(),
});

/**
 * What a run's steps cost, in USD at list price, or undefined when no step
 * reported a cost.
 *
 * `cost` alone is OpenRouter's own charge. On a BYOK route — Hack Club's
 * Anthropic key, which serves haiku — that is 0 and the inference is billed to
 * the key's owner, so the real figure is `upstream_inference_cost`. Reading only
 * `cost` logged every haiku turn as free. Hack Club's per-model discount (30% on
 * Anthropic-served Claude, configured in its database) is applied on its side
 * and is not visible here.
 */
export function stepsCostUsd(
  steps: readonly { usage: { raw?: unknown } }[]
): number | undefined {
  let total: number | undefined;
  for (const step of steps) {
    const parsed = rawUsage.safeParse(step.usage.raw);
    if (!parsed.success) {
      continue;
    }
    const { cost, cost_details, is_byok } = parsed.data;
    const upstream = is_byok
      ? cost_details?.upstream_inference_cost
      : undefined;
    if (cost === undefined && upstream === undefined) {
      continue;
    }
    total = (total ?? 0) + (cost ?? 0) + (upstream ?? 0);
  }
  return total;
}

/**
 * Prompt tokens each step WROTE to the prompt cache, from the raw usage.
 * OpenRouter reports them as `prompt_tokens_details.cache_write_tokens`, which
 * the openai-compatible provider does not map, so the turn log said `write: 0`
 * on every turn — a cache write costs 1.25x a plain token on Anthropic, which
 * is exactly what the log exists to show.
 */
export function stepsCacheWrites(
  steps: readonly { usage: { raw?: unknown } }[]
): number[] {
  return steps.map(
    (step) =>
      rawUsage.safeParse(step.usage.raw).data?.prompt_tokens_details
        ?.cache_write_tokens ?? 0
  );
}
