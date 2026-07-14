import { keys } from '../keys';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';
const OPENROUTER_BASE_URL =
  env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

export const GEMINI_PROVIDER = 'gemini';
export const HACKCLUB_PROVIDER = 'hackclub';
// DigitalOcean models reached through OpenRouter BYOK (the owner's key). The
// key holds $0 OpenRouter credit, so every attempt MUST force the DigitalOcean
// provider (agent.ts injects `provider: { only: ['digitalocean'] }`) — that's
// the free BYOK path, billed to the owner's DigitalOcean account on a separate
// quota from HackClub. See DIGITALOCEAN_MODELS for the tool-capable roster.
export const DIGITALOCEAN_PROVIDER = 'openrouter-do';
export const DIGITALOCEAN_ONLY = 'digitalocean';

/** One model attempt: an OpenAI-compatible endpoint + model slug. */
export interface ModelAttempt {
  apiKey: string;
  baseURL: string;
  /**
   * Set only on a BYOK attempt (the acting user's own key, see providers/byok):
   * the catalog id the key belongs to. Its presence is what marks the attempt as
   * "paid for by the user, not by the service" — which decides whether a failure
   * is reported back to them and whether the shared budget may be touched next.
   */
  byokProvider?: string;
  model: string;
  provider: string;
}

/**
 * The primary model for the main query: MiniMax M2.5, pinned, served by
 * DigitalOcean through OpenRouter BYOK — NOT HackClub. That means the main
 * query bills the owner's DigitalOcean account (its own quota) and never touches
 * HackClub's shared daily $3 cap, which is now only reached on fallback.
 *
 * A single pinned model (this replaced `openrouter/auto`, whose per-request
 * re-routing produced empty completions and long fallback cascades), so 1-hour
 * prompt caching sticks across a thread's turns. On failure the agent walks
 * LEADERBOARD_FALLBACK; minimax-m2.5 is also a rung there, deduped via
 * `failedKeys` so it isn't retried.
 */
export const PRIMARY_MODEL = 'minimax-m2.5';

// Used as the primary ONLY when no OpenRouter BYOK key is configured, so the
// agent always has a first attempt to route to.
const HACKCLUB_PRIMARY_FALLBACK_MODEL = 'z-ai/glm-5.2';

// Auto-router cost/quality bias: 0 = pure quality, 7 = default, 10 = cheapest.
// Retained for reference only — the auto-router path was removed (see
// ROUTER_MODEL above); nothing injects this anymore.
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
    provider: HACKCLUB_PROVIDER,
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

// DigitalOcean-served, TOOL-CAPABLE models (verified via OpenRouter BYOK with
// `provider.only=digitalocean`), best→worst. gpt-oss-120b and kimi-k2.5 are
// deliberately excluded — DigitalOcean's endpoints for them reject tool use,
// which makes them useless for kyto's tool-driven loop. These are short BYOK
// aliases (OpenRouter resolves `glm-5.2` → `z-ai/glm-5.2-…`); the `-fast`/
// `-normal` proxy aliases in the owner's list are NOT valid OpenRouter ids.
const DIGITALOCEAN_MODELS = [
  'glm-5.2',
  'deepseek-v4-pro',
  'kimi-k2.6',
  'qwen3.5-397b-a17b',
  'minimax-m2.5',
  'glm-5',
  'deepseek-v4-flash',
  'llama-4-maverick',
  'mimo-v2.5-pro',
] as const;

export const digitaloceanAttempts: ModelAttempt[] = env.OPENROUTER_API_KEY
  ? DIGITALOCEAN_MODELS.map((model) => ({
      apiKey: env.OPENROUTER_API_KEY as string,
      baseURL: OPENROUTER_BASE_URL,
      model,
      provider: DIGITALOCEAN_PROVIDER,
    }))
  : [];

/**
 * The attempt the main query starts on: PRIMARY_MODEL on DigitalOcean BYOK.
 * Falls back to a HackClub-served model only if `OPENROUTER_API_KEY` is unset
 * (no BYOK path exists at all) — otherwise a missing key would leave the agent
 * with no first attempt to route to.
 */
export const PRIMARY_ATTEMPT: ModelAttempt =
  digitaloceanAttempts.find((attempt) => attempt.model === PRIMARY_MODEL) ??
  catalogAttempt(HACKCLUB_PRIMARY_FALLBACK_MODEL);

/** Build a single direct-Gemini attempt, or undefined if no key is set. */
export function geminiAttempt(model: string): ModelAttempt | undefined {
  return env.GEMINI_API_KEY
    ? {
        apiKey: env.GEMINI_API_KEY,
        baseURL: GEMINI_BASE_URL,
        model,
        provider: GEMINI_PROVIDER,
      }
    : undefined;
}

// The models a subagent runs on, best-value first: the cheap Gemini flash-lite
// tier when the owner's key is set, then the DigitalOcean BYOK roster. A
// subagent walks this list on failure OR on an empty report — the cheap tier
// returns an empty completion often enough that a single pinned model made a
// "herd" of subagents mostly report nothing back.
export const subagentAttempts: ModelAttempt[] = [
  geminiAttempt('gemini-3.1-flash-lite'),
  ...digitaloceanAttempts,
].filter((attempt): attempt is ModelAttempt => attempt !== undefined);

/** The subagent's primary model; undefined = no subagent model configured. */
export const subagentAttempt: ModelAttempt | undefined = subagentAttempts[0];

// The owner's arena leaderboard, best→worst, restricted to models reachable on
// HackClub. Fable 5 (rank #1) is reachable (`anthropic/claude-fable-5`) but
// deliberately excluded — ~2x opus-4.8's per-token cost, not worth it against
// the daily HackClub spend cap. The agent tries PRIMARY_ATTEMPT first, then
// walks this list in RANK ORDER, best first (buildFallbackQueue in the bot's
// agent loop). Order matters: it is the order kyto actually falls back in.
//
// EVERY RUNG MUST BE A MODEL GOOD ENOUGH TO HAND A LIVE THREAD TO. A fallback
// is not a consolation prize — whichever rung answers IS kyto for that turn, in
// public, in front of the same people. `nvidia/nemotron-3-ultra-550b-a55b` was
// a rung until it degenerated into a token loop and streamed "@devansh" several
// hundred times into a public thread; it is not coming back, and neither is
// anything else that can't hold a multi-step tool conversation. Reachable on
// the proxy is NOT the bar. (See also the repetition guard in the agent loop,
// which now aborts an attempt that starts looping rather than posting it.)
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
  // DigitalOcean via OpenRouter BYOK — strong, tool-capable models on a
  // SEPARATE quota (billed to the owner's DigitalOcean account, not HackClub).
  // buildFallbackQueue walks these BEFORE the HackClub rungs above (free, and
  // the primary already lives here), so their position in this list only orders
  // them against each other. Empty if OPENROUTER_API_KEY is unset.
  ...digitaloceanAttempts,
  // Last resort: the owner's OWN Gemini key — walked after every DigitalOcean
  // and HackClub rung, and reached immediately when both of those tiers are
  // out (DO rate limit + HackClub budget). Empty if the key is unset.
  ...geminiAttempts,
];
