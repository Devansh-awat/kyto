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
  /**
   * Extra request headers merged onto every call for this attempt. Used by the
   * "Sign in with ChatGPT" path (providers/chatgpt) to send the account-scoping
   * header the ChatGPT backend expects; unset for every other attempt.
   */
  headers?: Record<string, string>;
  model: string;
  provider: string;
}

/**
 * The primary model for the main query: Kimi K2.7, pinned, served by
 * **HackClub** (`moonshotai/kimi-k2.7-code`, the only K2.7 slug HackClub
 * exposes) — owner's call. K2.7 on HackClub, K2.6 on DigitalOcean (see
 * DIGITALOCEAN_MODELS); the two are distinct fallback entries (`failedKeys` is
 * keyed on provider+model) so a DO-served K2.6 is still tried when this fails.
 *
 * COST NOTE, because this reverses an earlier decision: the primary used to be
 * a DigitalOcean BYOK model precisely so the main query billed the owner's DO
 * quota and HackClub's shared daily $3 cap was only ever touched on fallback.
 * With the primary on HackClub, **every turn now spends that daily cap** — which
 * is the intent (DigitalOcean was rate-limiting the roster). The DigitalOcean
 * roster is still the FIRST fallback tier (free, and no longer rate-limit-
 * blocked, since the primary no longer hammers it), and a HackClub budget/outage
 * failure still short-circuits straight to it.
 *
 * A single pinned model (this replaced `openrouter/auto`, whose per-request
 * re-routing produced empty completions and long fallback cascades), so 1-hour
 * prompt caching (addCacheControl in agent.ts) sticks across a thread's turns —
 * which is what keeps K2.7 competitive on cost with the K2.6 it replaced.
 */
export const PRIMARY_MODEL = 'moonshotai/kimi-k2.7-code';

// Cap output tokens on HackClub requests. OpenRouter enforces the daily spend
// limit PESSIMISTICALLY: with no `max_tokens` it assumes the model could emit
// its full max output, projects that worst-case cost, and 429s when the
// projection crosses the cap even with budget still free. Sized to observed
// step outputs (<6k tokens). Raise if large single-step file writes truncate.
export const MAX_OUTPUT_TOKENS = 8000;

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
//
// Kimi K2.6 LEADS this tier: it's the DigitalOcean-served K2.x (K2.7 is NOT on
// DigitalOcean — `moonshotai/kimi-k2.7` is an invalid OpenRouter id and
// `kimi-k2.7-code` has no DigitalOcean provider, verified), so K2.7 lives on
// HackClub (the primary) and K2.6 is the DO counterpart. `glm-5.2` was dropped
// from this tier for cost (owner's call — expensive on the DO account); it stays
// on the HackClub leaderboard, which is a separate quota.
const DIGITALOCEAN_MODELS = [
  'kimi-k2.6',
  'deepseek-v4-pro',
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
 * The attempt the main query starts on: PRIMARY_MODEL, served by HackClub. No
 * key-dependent degradation any more — HackClub is always configured, whereas
 * the DigitalOcean path needs OPENROUTER_API_KEY.
 */
export const PRIMARY_ATTEMPT: ModelAttempt = catalogAttempt(PRIMARY_MODEL);

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
// So the list is EXACTLY the owner's arena top 19 — nothing gets to be a rung
// just for existing on the proxy. When the owner hands over a new leaderboard,
// REPLACE this list with it; do not merge the old tail back in. That tail is
// where the junk lives (the previous one trailed off into grok-build-0.1,
// minimax-m2.7 and nemotron, all now gone).
//
// The baishui proxy tail (jam06452.uk) stays disabled — its /models endpoint
// answers but every completion fails ("upstream authentication failed" / "all
// provider keys rate-limited or in cooldown"). Re-add rungs here only after
// verifying a real completion succeeds.
//
// The arena ranks a model + a REASONING EFFORT ("High", "xHigh", "Thinking"),
// but the proxy only has one slug per model — GPT 5.5 holds ranks 2/4/8/10 and
// Opus 4.8 holds 3 and 14. Each model therefore appears ONCE here, at its BEST
// rank. Every slug below was verified against ai.hackclub.com/proxy/v1/models.
export const LEADERBOARD_FALLBACK: ModelAttempt[] = [
  // Owner's arena top 19, in rank order. Rank #1 (Claude Fable 5) is reachable
  // as `anthropic/claude-fable-5` and deliberately skipped — see above.
  catalogAttempt('openai/gpt-5.6-sol'), // 2
  catalogAttempt('anthropic/claude-opus-4.8'), // 3
  catalogAttempt('openai/gpt-5.5'), // 4
  catalogAttempt('anthropic/claude-sonnet-5'), // 5
  catalogAttempt('anthropic/claude-opus-4.7'), // 6
  catalogAttempt('z-ai/glm-5.2'), // 9
  catalogAttempt('anthropic/claude-opus-4.6'), // 11
  catalogAttempt('openai/gpt-5.4'), // 12
  // Rank 13 (Grok 4.5) is listed on the proxy but NOT usable from this host:
  // xAI hard-403s it, `permission-denied: The model grok-4.5 is not available
  // in your region`. It would burn an attempt on every fallback, so it is not a
  // rung. Re-add if the region block ever lifts (verify with a real completion).
  catalogAttempt('anthropic/claude-sonnet-4.6'), // 15
  catalogAttempt('z-ai/glm-5.1'), // 16
  catalogAttempt('qwen/qwen3.7-plus'), // 17
  catalogAttempt('google/gemini-3.1-pro-preview'), // 18
  catalogAttempt('moonshotai/kimi-k2.7-code'), // 19
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
