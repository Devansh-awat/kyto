import { keys } from '../keys';
import { GEMINI_PROVIDER, HACKCLUB_PROVIDER } from './names';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export { GEMINI_PROVIDER, HACKCLUB_PROVIDER } from './names';

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
 * exposes) — owner's call.
 *
 * COST NOTE: **every turn spends HackClub's shared daily $3 cap**, so
 * `BudgetExhaustedError` is reachable in ordinary use. There used to be a
 * DigitalOcean tier (reached through an OpenRouter key with BYOK billing) that
 * absorbed the primary and the first fallback rungs for free; that account is
 * gone (2026-07-27), so HackClub is the only shared tier and the owner's own
 * Gemini key is the last resort.
 *
 * A single pinned model (this replaced `openrouter/auto`, whose per-request
 * re-routing produced empty completions and long fallback cascades), so 1-hour
 * prompt caching (addCacheControl in agent.ts) sticks across a thread's turns.
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

/**
 * The attempt the main query starts on: PRIMARY_MODEL, served by HackClub.
 * HackClub is always configured, so this never degrades on a missing key.
 */
export const PRIMARY_ATTEMPT: ModelAttempt = catalogAttempt(PRIMARY_MODEL);

// The models a subagent runs on, best-value first: the owner's own Gemini key
// (cheap, and a quota separate from HackClub's shared daily cap), then a single
// HackClub rung as the floor. A subagent walks this list on failure OR on an
// empty report — the cheap tier returns an empty completion often enough that a
// single pinned model made a "herd" of subagents mostly report nothing back.
//
// The HackClub rung is last on purpose: it spends the same shared budget the
// main turn needs. It is here so the subagent tool still works with no Gemini
// key at all (an empty list disables the tool outright).
export const subagentAttempts: ModelAttempt[] = [
  ...geminiAttempts,
  catalogAttempt(PRIMARY_MODEL),
];

/** The subagent's primary model; undefined = no subagent model configured. */
export const subagentAttempt: ModelAttempt | undefined = subagentAttempts[0];

// The HackClub rungs kyto falls back to, and the whole list is CHEAP ON PURPOSE
// (owner's call, 2026-07-27). It used to be the owner's arena top 19 in rank
// order — opus-4.8, gpt-5.6-sol, sonnet-5 and the rest. Those are all GONE.
//
// Why: the primary is pinned kimi-k2.7-code at $0.73/M in, and the whole tier
// shares ONE daily $3 cap. Falling back to opus-4.8 ($10/M in — 14x) meant a
// transient proxy failure, which says nothing about the model, could spend a
// large part of the day's budget on a single turn. The failures that actually
// happen here are gateway 504s and dropped connections, not "kimi is too weak
// for this" — so the right response is another model of the SAME class, not a
// more expensive one.
//
// EVERY RUNG MUST STILL BE A MODEL GOOD ENOUGH TO HAND A LIVE THREAD TO. Cheap
// is a constraint, not the bar. A fallback is not a consolation prize —
// whichever rung answers IS kyto for that turn, in public, in front of the same
// people. `nvidia/nemotron-3-ultra-550b-a55b` was a rung until it degenerated
// into a token loop and streamed "@devansh" several hundred times into a public
// thread; it is not coming back, and neither is anything else that can't hold a
// multi-step tool conversation. Reachable on the proxy is NOT the bar, and
// "cheapest on the proxy" is not either. Both rungs below are K2-class coding
// models verified `tools`-capable on ai.hackclub.com/proxy/v1/models.
//
// If a rung is ever added back, price it first: anything materially above the
// primary's per-token cost belongs behind the Gemini key, not in front of it.
//
// The baishui proxy tail (jam06452.uk) stays disabled — its /models endpoint
// answers but every completion fails ("upstream authentication failed" / "all
// provider keys rate-limited or in cooldown"). Re-add rungs here only after
// verifying a real completion succeeds.
export const LEADERBOARD_FALLBACK: ModelAttempt[] = [
  // Kimi K2.6: the primary's own predecessor, and CHEAPER than it
  // ($0.646/M in, $2.72/M out, 262k ctx). The closest thing to "the same model
  // again" when a request to K2.7 was lost rather than refused.
  catalogAttempt('moonshotai/kimi-k2.6'),
  // MiniMax M3 ($0.30/M in, $1.20/M out, 1M ctx) — the cheapest rung that still
  // holds a tool conversation, and the widest context of the three, so it is
  // also the one most likely to survive a long thread the others would not.
  catalogAttempt('minimax/minimax-m3'),
  ...geminiAttempts,
];
