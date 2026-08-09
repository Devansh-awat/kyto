import { keys } from '../keys';
import {
  GEMINI_PROVIDER,
  HACKCLUB_PROVIDER,
  MEBBO_PROVIDER,
  OPENCODE_PROVIDER,
} from './names';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export {
  GEMINI_PROVIDER,
  HACKCLUB_PROVIDER,
  MEBBO_PROVIDER,
  OPENCODE_PROVIDER,
} from './names';

const MEBBO_BASE_URL = env.MEBBO_BASE_URL ?? 'https://chat.mebbo.cloud/api';

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
 * The primary model for the main query: DeepSeek V4 Flash (the 0731 retrain),
 * pinned, served by **HackClub** — owner's call (2026-08-01, "IT WORKED … we can
 * use it now"). It replaced `qwen/qwen3.7-plus`, which it beats on benchmarks
 * AND on cost: ~$0.14/M in and ~$0.28/M out (measured from a live proxy
 * completion, `upstream_inference_prompt_cost`) vs qwen's $0.32/$1.28. Verified
 * `tools`-capable and returning a real completion on ai.hackclub.com/proxy/v1.
 *
 * It was a fallback rung that 404'd for weeks ("No endpoints available matching
 * your guardrail restrictions and data policy") because its only OpenRouter
 * providers trained on prompts, which HackClub's account data policy forbids.
 * A no-train provider (Cloudflare) came online and the 404 became a 200 — the
 * signal MODELS.md said to watch for before promoting it to primary.
 *
 * CAVEAT — it is a REASONING model (emits `reasoning`/`reasoning_content`). Some
 * reasoning models think before their first token, and HackClub aborts an
 * upstream request that has not returned response HEADERS within 5s and turns it
 * into a 504 (`UPSTREAM_HEADER_TIMEOUT_MS`, hackclub/ai
 * `src/routes/proxy/v1/general.ts`) — so a slow first byte loses turns at the
 * proxy. The live probe returned fast and `gateway-retry.ts` replays a 504
 * before it can cost a fallback, but if 504s spike after this promotion, the
 * first-byte latency is the suspect and qwen3.7-plus (now the top fallback rung)
 * is the model to pin back. See MODELS.md.
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
export const PRIMARY_MODEL = 'deepseek/deepseek-v4-flash-0731';

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
//
// `gemini-3.5-flash-lite` leads (owner's call, 2026-07-29, replacing
// `gemini-3.1-flash-lite`): newer, and verified against this key on 2026-07-29
// — 200 with a real `tool_calls` response, first byte in well under the 5s that
// matters upstream. There is NO `gemini-3.6-flash-lite`; the 2026-07-21 release
// was 3.6 Flash + 3.5 Flash-Lite, so `gemini-3.6-flash` is the 3.6 rung and it
// verified the same way.
//
// AI Studio's free tier meters flash-lite at ~15 requests/minute. That is per
// MINUTE, not per turn, and an agentic turn makes one request per step — so a
// long tool loop on this rung can pace into a 429. It sits below the HackClub
// tier for that reason, not above it.
const GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
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

// A free tier a friend of the owner runs: OpenWebUI on his own Ubuntu box
// (chat.mebbo.cloud), fronting free upstream endpoints, on ONE key shared with
// everyone he handed it to. Free and genuinely useful, but NOT primary material,
// which is the call the owner asked for (2026-08-05, "if it has better models
// than our deepseek v4 flash and also works well, use as primary, otherwise
// before gemini"). Measured that day:
//   - `deepseek-v4-pro` and `gpt-oss-120b` return real `tool_calls`, first byte
//     in ~0.1-0.5s. Both are strictly better models than the flash primary.
//   - but `glm-5.2` and `kimi-k3-free` HUNG — no bytes at all in 95s, which is
//     worse than an error (an idle stall burns the watchdog);
//   - and at 10 concurrent requests 2 of 10 came back 400 while latency for a
//     five-token reply went to 18s. A kyto turn is one request per STEP, so a
//     tool loop would sit on that limit constantly.
// So: a fallback tier ahead of the Gemini key, carrying only the two models that
// verified. Unset key = the tier simply isn't there.
const MEBBO_MODELS = [
  'deepseek-ai/deepseek-v4-pro',
  'openai/gpt-oss-120b',
] as const;

const mebboAttempts: ModelAttempt[] = env.MEBBO_API_KEY
  ? MEBBO_MODELS.map((model) => ({
      apiKey: env.MEBBO_API_KEY as string,
      baseURL: MEBBO_BASE_URL,
      model,
      provider: MEBBO_PROVIDER,
    }))
  : [];

// OpenCode Zen's FREE models (opencode.ai/zen). The paid catalogue there needs a
// payment method the workspace has not attached — every paid slug answers
// `CreditsError: No payment method` — but the free slugs need nothing at all.
//
// Measured 2026-08-09, seven checks each (letter counting, the bat-and-ball
// trap, a memoized-fib one-liner, weekday arithmetic 100 days back, exact
// instruction following, compact-JSON output, and one real tool call):
//
//   big-pickle              7/7, 8.5s avg   ← the owner guessed right
//   deepseek-v4-flash-free  7/7, 9.5s       ← the SAME model as the primary, free
//   longcat-2.0-free        7/7, 11.3s
//   nemotron-3-ultra-free   6/7, 17.0s      (fell for the bat and ball)
//   mimo-v2.5-free          5/7, 10.2s
//   laguna-s-2.1-free       4/7, 12.9s
//   north-mini-code-free, ling-3.0-flash-free — upstream 500s, unusable
//
// Only the three that scored 7/7 are wired, best first. THE COST IS NOT MONEY:
// their docs say that during the free period "collected data may be used to
// improve the model", and a kyto turn carries other people's Slack messages. So
// the owner's call (2026-08-09) was "last resort, not as last as gemini" — it
// sits below mebbo and above the Gemini key, so it only ever runs on a turn
// every paid and free-but-private tier has already failed.
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_MODELS = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'longcat-2.0-free',
] as const;

const opencodeAttempts: ModelAttempt[] = env.OPENCODE_API_KEY
  ? OPENCODE_MODELS.map((model) => ({
      apiKey: env.OPENCODE_API_KEY as string,
      baseURL: OPENCODE_BASE_URL,
      model,
      provider: OPENCODE_PROVIDER,
    }))
  : [];

// Models that CANNOT accept image input. The deepseek-v4-flash primary is served
// by Cloudflare, which is text-only: any turn carrying an image 404s ("No
// endpoints found that support image input") and burns a doomed attempt before
// falling back. For a text-only model kyto pre-describes the image with Gemini
// (see vision.ts) and feeds the description as text instead of the raw pixels.
const TEXT_ONLY_MODELS = new Set<string>(['deepseek/deepseek-v4-flash-0731']);

/** True unless the model's endpoint is known to reject image input. */
export function modelSupportsVision(model: string): boolean {
  return !TEXT_ONLY_MODELS.has(model);
}

// A vision-capable Gemini attempt (owner's key, a quota separate from HackClub's
// shared cap) used ONLY to describe images for a text-only primary — it is NOT a
// rung in the answer fallback chain. gemini-2.5-flash is a cheap, reliable
// vision/OCR model; undefined when no Gemini key is configured (then a text-only
// primary simply can't see images, same as before this existed).
export const visionAttempt: ModelAttempt | undefined = env.GEMINI_API_KEY
  ? {
      apiKey: env.GEMINI_API_KEY,
      baseURL: GEMINI_BASE_URL,
      model: 'gemini-2.5-flash',
      provider: GEMINI_PROVIDER,
    }
  : undefined;

/**
 * The attempt the main query starts on: PRIMARY_MODEL, served by HackClub.
 * HackClub is always configured, so this never degrades on a missing key.
 */
export const PRIMARY_ATTEMPT: ModelAttempt = catalogAttempt(PRIMARY_MODEL);

/**
 * Where `upgradeModel` sends a turn: the rungs kyto escalates to when the model
 * itself says the task is beyond it (owner's call, 2026-08-05 — "model self
 * escalate whenever needed … anyone can escalate it").
 *
 * These are DEAR. kimi-k3 is $3/M in and $15/M out against the primary's
 * $0.14/$0.28 — roughly 20x and 50x — and the whole HackClub tier shares one
 * $3/day cap, so a single long escalated turn can eat most of a day's budget.
 * That is why escalation is capped per turn AND per day (see the upgradeModel
 * tool), and why the ladder is ordered cheapest-capable-first rather than
 * "best": claude-sonnet-5 ($2/$10) is the second rung, not the first, and
 * nothing here is a `-pro` variant (gpt-5.4-pro is $30/M in — one turn).
 *
 * Both are verified tools-capable on the proxy and both take images, so an
 * escalated turn can still see an attachment the text-only primary could not.
 */
export const UPGRADE_ATTEMPTS: ModelAttempt[] = [
  catalogAttempt('moonshotai/kimi-k3'),
  catalogAttempt('anthropic/claude-sonnet-5'),
];

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
// Why: the primary is a pinned cheap model, and the whole tier shares ONE daily
// $3 cap. Falling back to opus-4.8 ($10/M in — 30x the primary) meant a
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
// "cheapest on the proxy" is not either. Both rungs below hold a multi-step
// tool conversation and are verified `tools`-capable on
// ai.hackclub.com/proxy/v1/models.
//
// If a rung is ever added back, price it first: anything materially above the
// primary's per-token cost belongs behind the Gemini key, not in front of it.
//
// The baishui proxy tail (jam06452.uk) stays disabled — its /models endpoint
// answers but every completion fails ("upstream authentication failed" / "all
// provider keys rate-limited or in cooldown"). Re-add rungs here only after
// verifying a real completion succeeds.
export const LEADERBOARD_FALLBACK: ModelAttempt[] = [
  // Qwen3.7 Plus ($0.32/M in, $1.28/M out, 1M ctx) — the former PRIMARY, demoted
  // to the top fallback rung when deepseek-v4-flash was promoted over it
  // (2026-08-01). It held the primary slot for weeks with no quality complaints,
  // so it is the natural first fall-back and the model to pin BACK if the
  // deepseek promotion turns out to lose turns at the proxy's 5s header timeout
  // (deepseek is a reasoning model — see PRIMARY_MODEL's caveat). Verified
  // `tools`-capable on ai.hackclub.com/proxy/v1/models.
  catalogAttempt('qwen/qwen3.7-plus'),
  // MiniMax M3 ($0.30/M in, $1.20/M out, 1M ctx) — cheap and the same 1M context
  // class, so falling onto it cannot fail on a long thread an earlier rung was
  // holding. Dearer than the deepseek primary now, but still cheap in absolute
  // terms. It measured clean where kimi-k2.7-code did not: 200/200 successes
  // against its 99/100, same probe, same minute (2026-07-28).
  catalogAttempt('minimax/minimax-m3'),
  // Kimi K2.6 ($0.646/M in, $2.72/M out, 262k ctx). The most expensive rung here
  // — several times the deepseek primary's per-token cost — so it sits LAST among
  // the HackClub rungs rather than being dropped: it is a different model family
  // from the primary, qwen and M3, which is the point of a fourth rung, and it is
  // still cheap in absolute terms. If the daily cap starts running out, this is
  // the first rung to cut.
  catalogAttempt('moonshotai/kimi-k2.6'),
  // The free mebbo tier sits between HackClub and the owner's Gemini key: it
  // costs nothing at all, so it is worth trying before spending Gemini quota,
  // but it is a hobby box and cannot be relied on to hold a turn.
  ...mebboAttempts,
  // OpenCode Zen's free models, below mebbo because they are free in money but
  // not in privacy (see OPENCODE_MODELS), and above the Gemini key because a
  // turn reaching this far has already lost every other option.
  ...opencodeAttempts,
  ...geminiAttempts,
];
