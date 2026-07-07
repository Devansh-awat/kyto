import { keys } from '../keys';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export const GEMINI_PROVIDER = 'gemini';

/** One model attempt: an OpenAI-compatible endpoint + model slug. */
export interface ModelAttempt {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
}

/**
 * The primary model for the main query: OpenRouter's own auto-router, reached
 * through the OpenRouter-compatible HackClub proxy. OpenRouter picks the best
 * underlying model per request.
 */
export const ROUTER_MODEL = 'openrouter/auto';

// Auto-router cost/quality bias: 0 = pure quality, 7 = default, 10 = cheapest.
export const COST_QUALITY_TRADEOFF = 7;

// Cap output tokens on HackClub requests. OpenRouter enforces the daily spend
// limit PESSIMISTICALLY: with no `max_tokens` it assumes the model could emit
// its full max output, projects that worst-case cost, and 429s when the
// projection crosses the cap even with budget still free. Sized to observed
// step outputs (<6k tokens). Raise if large single-step file writes truncate.
export const MAX_OUTPUT_TOKENS = 8000;

// Restrict the auto-router to these EXACT model ids (owner-chosen allowlist).
// Passed as the auto-router plugin's `allowed_models` field (NOT
// `model_patterns` — silently ignored). Exact slugs, not globs, so trimmed
// variants (-nano/-mini/-flash-lite/-fast) and claude-fable-5 (~2x opus-4.8
// cost) can never be routed to.
export const ALLOWED_MODELS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'z-ai/glm-5.2',
  'z-ai/glm-5.1',
  // `google/gemini-3.5-flash` previously had a 100% empty-response rate in
  // production; re-added at the owner's request — re-remove if it recurs.
  // `google/gemini-3.1-pro-preview` was dropped (owner: too expensive).
  'google/gemini-3.5-flash',
  // Cheap tier: lets auto route simple/casual turns to a low-cost model
  // instead of always landing on the premium tier (the main cost blowup).
  'google/gemini-3.1-flash-lite',
];

/** Build a HackClub attempt for any model id. */
export function catalogAttempt(model: string): ModelAttempt {
  return {
    apiKey: env.HACKCLUB_API_KEY,
    baseURL: HACKCLUB_BASE_URL,
    model,
    provider: 'hackclub',
  };
}

// Gemini (owner's own GEMINI_API_KEY, direct Google OpenAI-compat endpoint) —
// separate quota from HackClub, cheap and reliable. `gemini-3.5-flash` stays
// OUT of this direct-key list on purpose: every direct attempt returned an
// empty response with ZERO requests metered on the Google AI Studio dashboard
// (rejected before generation, likely tier-gated) — the HackClub-proxied slug
// is a different request path and is allowed above/below instead.
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
] as const;

const geminiAttempts: ModelAttempt[] = env.GEMINI_API_KEY
  ? GEMINI_MODELS.map((model) => ({
      apiKey: env.GEMINI_API_KEY as string,
      baseURL: GEMINI_BASE_URL,
      model,
      provider: GEMINI_PROVIDER,
    }))
  : [];

// The owner's arena leaderboard, best→worst, restricted to models reachable on
// HackClub. Fable 5 (rank #1) is reachable (`anthropic/claude-fable-5`) but
// deliberately excluded — ~2x opus-4.8's per-token cost, not worth it against
// the daily HackClub spend cap. The agent runs `openrouter/auto` first, retries
// the exact model it resolved to, then walks THIS list UP from that model
// (toward #1) and then DOWN (toward the weakest). Order matters: each entry's
// index is the rank used for the up/down pivot.
//
// The baishui proxy tail (jam06452.uk) stays disabled — its /models endpoint
// answers but every completion fails ("upstream authentication failed" / "all
// provider keys rate-limited or in cooldown"). Re-add rungs here only after
// verifying a real completion succeeds.
export const LEADERBOARD_FALLBACK: ModelAttempt[] = [
  catalogAttempt('anthropic/claude-opus-4.8'),
  catalogAttempt('openai/gpt-5.5'),
  catalogAttempt('anthropic/claude-opus-4.7'),
  catalogAttempt('anthropic/claude-opus-4.6'),
  catalogAttempt('openai/gpt-5.4'),
  catalogAttempt('z-ai/glm-5.2'),
  catalogAttempt('anthropic/claude-sonnet-4.6'),
  catalogAttempt('z-ai/glm-5.1'),
  // The rest of the owner's leaderboard, appended in rank order (verified
  // reachable via ai.hackclub.com/proxy/v1/models). `google/gemini-3.5-flash`
  // is HackClub-only (see GEMINI_MODELS note); re-remove if the
  // empty-response failure recurs.
  catalogAttempt('moonshotai/kimi-k2.7-code'),
  catalogAttempt('google/gemini-3.5-flash'),
  catalogAttempt('deepseek/deepseek-v4-flash'),
  catalogAttempt('moonshotai/kimi-k2.6'),
  catalogAttempt('minimax/minimax-m3'),
  catalogAttempt('deepseek/deepseek-v4-pro'),
  catalogAttempt('qwen/qwen3.6-plus'),
  catalogAttempt('x-ai/grok-4.3'),
  catalogAttempt('x-ai/grok-build-0.1'),
  catalogAttempt('google/gemini-3-flash-preview'),
  catalogAttempt('minimax/minimax-m2.7'),
  catalogAttempt('nvidia/nemotron-3-ultra-550b-a55b'),
  // Last resort: the owner's OWN Gemini key — reached after the HackClub rungs
  // fail (and immediately on a HackClub budget-exhaustion 429). Empty if the
  // key is unset (then these rungs are simply skipped).
  ...geminiAttempts,
];
