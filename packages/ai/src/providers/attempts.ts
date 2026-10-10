import { keys } from '../keys';
import { GEMINI_PROVIDER, HACKCLUB_PROVIDER, MEBBO_PROVIDER } from './names';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export {
  GEMINI_PROVIDER,
  HACKCLUB_PROVIDER,
  MEBBO_PROVIDER,
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
 * The primary model for main queries: Claude Haiku 5.5 via the Hack Club
 * gateway, pinned to Anthropic's own API (`ANTHROPIC_ONLY_MODELS`). Owner's
 * call, 2026-10-10: Hack Club takes 30% off a Claude request ONLY when
 * OpenRouter's upstream that served it was Anthropic (its billing `discounts`,
 * matched on the upstream that ran) — Vertex, Bedrock, Azure and AWS host the
 * same model at the same list price ($0.10/M in, $0.50/M out, same as luna)
 * and get nothing off.
 */
export const PRIMARY_MODEL = 'anthropic/claude-haiku-5.5';

/**
 * GPT-6 Luna, the primary 2026-10-05 → 2026-10-10, now the first fallback: ~2x
 * GLM's output rate and served by OpenAI directly, so an Anthropic outage on
 * the pinned primary lands on a different vendor.
 */
export const LUNA_MODEL = 'openai/gpt-6-luna';

/**
 * Models that may be served ONLY by Anthropic's own API, never another host —
 * the 30% Hack Club discount needs Anthropic to be the upstream that ran. No
 * fallback host: if Anthropic refuses, the turn walks to the next RUNG instead.
 */
export const ANTHROPIC_ONLY_MODELS = new Set<string>([PRIMARY_MODEL]);

/** The primary before luna — smart but slow — and now the second fallback. */
const GLM_FLASH_MODEL = 'z-ai/glm-5.3-flash';

/** The primary before GLM, now the second fallback rung: proven and cheap. */
const FORMER_PRIMARY_MODEL = 'deepseek/deepseek-v4-flash-0731';

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
// before gemini").
//
// EMPTY as of 2026-08-22: both rungs that verified on 2026-08-05 are now dead
// from this host, so every fallback walk was paying two doomed attempts for them.
//   - `deepseek-ai/deepseek-v4-pro` answers `400 {"detail":"Model not found"}` —
//     it is no longer in the box's /models listing at all.
//   - `openai/gpt-oss-120b` still answers a one-word probe, but its upstream
//     (Groq, `service tier on_demand`) caps the key at 8000 tokens per minute and
//     a kyto turn's prompt is 13-20k, so every REAL request 400s "Request too
//     large … Limit 8000, Requested 19434". A rung that only passes a toy probe
//     is not a rung; that is exactly why the note above says to verify with a
//     real completion.
// The tier stays wired (base URL, provider, the queue entry) so re-adding a slug
// is one line — but verify it at KYTO's prompt size, not with "hi".
const MEBBO_MODELS: readonly string[] = [];

const mebboAttempts: ModelAttempt[] = env.MEBBO_API_KEY
  ? MEBBO_MODELS.map((model) => ({
      apiKey: env.MEBBO_API_KEY as string,
      baseURL: MEBBO_BASE_URL,
      model,
      provider: MEBBO_PROVIDER,
    }))
  : [];

// Models that cannot accept image input. DeepSeek V4 Flash is served by
// Cloudflare, which is text-only: an image turn otherwise 404s before fallback.
// GPT-6 Luna and GLM 5.3 Flash are vision-capable, so neither is in this set.
const TEXT_ONLY_MODELS = new Set<string>([FORMER_PRIMARY_MODEL]);

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

/** The main query always starts on the configured Hack Club gateway primary. */
export const PRIMARY_ATTEMPT: ModelAttempt = catalogAttempt(PRIMARY_MODEL);

/**
 * Where `upgradeModel` sends a turn: the rungs kyto escalates to when the model
 * itself says the task is beyond it (owner's call, 2026-08-05 — "model self
 * escalate whenever needed … anyone can escalate it").
 *
 * These are DEAR. kimi-k3 is $3/M in and $15/M out against the low-cost Haiku
 * primary (and ~20x/50x the HackClub rungs behind it) — and the whole
 * HackClub tier shares one $3/day cap, so a single long escalated turn can eat
 * most of a day's budget. That is why escalation is capped per turn AND per day
 * (see the upgradeModel tool), and why the ladder is ordered
 * cheapest-capable-first rather than "best": claude-sonnet-5 ($2/$10) is the
 * second rung, not the first, and nothing here is a `-pro` variant.
 *
 * Both are verified tools-capable on the proxy and both take images.
 */
export const UPGRADE_ATTEMPTS: ModelAttempt[] = [
  catalogAttempt('moonshotai/kimi-k3'),
  catalogAttempt('anthropic/claude-sonnet-5'),
];

// The models a subagent runs on: **the same model the main turn runs on**
// (owner's call, 2026-08-21 — "subagent use same deepseek v4 flash"), i.e.
// PRIMARY_ATTEMPT itself, so subagents use the same model as the
// parent and follow future primary changes automatically. A
// subagent walks this list on failure OR on an empty report — a single pinned
// model made a "herd" of subagents mostly report nothing back.
//
// This ORDER was reversed on that date. Gemini used to lead because it spends a
// quota separate from HackClub's shared daily cap, but a subagent is doing a
// slice of the turn's own work and reporting back into it — a different model
// class meant the delegated half came back in a different voice, and worse at
// tool calling than the parent that delegated to it.
export const subagentAttempts: ModelAttempt[] = [
  PRIMARY_ATTEMPT,
  ...geminiAttempts,
];

/** The subagent's primary model; undefined = no subagent model configured. */
export const subagentAttempt: ModelAttempt | undefined = subagentAttempts[0];

// Compaction (lib/agent/compaction) deliberately did NOT follow the subagent
// onto the primary. It is a different job: one pass digests up to 200 thread
// messages, a long-idle thread catches up over MANY passes, and it runs in the
// BACKGROUND where nobody is watching the bill — so on a shared daily cap a
// single 25k-message backlog could spend the day on bookkeeping. It keeps the
// Gemini key first and only falls to HackClub's former primary if there is no
// Gemini key at all. Owner's call, 2026-08-21.
export const compactionAttempts: ModelAttempt[] = [
  ...geminiAttempts,
  catalogAttempt(FORMER_PRIMARY_MODEL),
];

/** The model compaction runs on; undefined = no compaction model configured. */
export const compactionAttempt: ModelAttempt | undefined =
  compactionAttempts[0];

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
  catalogAttempt(LUNA_MODEL),
  // GLM 5.3 Flash, the primary 2026-08-26 → 2026-10-05: smarter than Luna but
  // half its speed, and the same price class. Served through OpenRouter, so it
  // shares a failure mode Luna doesn't (the top-up-wait 429).
  catalogAttempt(GLM_FLASH_MODEL),
  // DeepSeek V4 Flash, the primary 2026-08-01 → 2026-08-21. It is proven
  // tools-capable and remains inexpensive.
  catalogAttempt(FORMER_PRIMARY_MODEL),
  // Qwen3.7 Plus ($0.32/M in, $1.28/M out, 1M ctx) — primary until deepseek
  // v4-flash was promoted over it (2026-08-01), demoted one place again by the
  // GLM Flash promotion (2026-08-26). It held the primary slot for weeks with no
  // quality complaints, so it remains a proven primary-class rung. Verified
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
  ...geminiAttempts,
];
