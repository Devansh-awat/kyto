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

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';

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
 * The former primary: DeepSeek V4 Flash (0731 retrain) on **HackClub** —
 * primary 2026-08-01 → 2026-08-21, now the top FALLBACK rung and the model to
 * pin back when the Zen window below closes (or OPENCODE_API_KEY goes unset,
 * which degrades to it automatically). Verified `tools`-capable; a REASONING
 * model, so watch first-byte latency against HackClub's 5s header timeout.
 */
const FORMER_PRIMARY_MODEL = 'deepseek/deepseek-v4-flash-0731';

/**
 * The primary model for the main query: **Ox Alpha Free** (`x-preview-f-free`),
 * a stealth model served FREE by OpenCode Zen (opencode.ai/zen, an
 * OpenAI-compatible gateway) — owner's call 2026-08-21 ("0x alpha is unlimited
 * as of now but will be removed from free tier in a week", after which kyto
 * returns to HackClub). TEMPORARY by design: when the window closes, delete this
 * block and point PRIMARY_ATTEMPT back at
 * `catalogAttempt(FORMER_PRIMARY_MODEL)` — which is also what happens
 * AUTOMATICALLY if OPENCODE_API_KEY is unset, so an expired/removed key can
 * never break every turn.
 *
 * WHY THIS IS LAWFUL WHEN THE REST OF ZEN IS NOT: the whole Zen free tier was
 * dropped on 2026-08-11 because its terms allowed training on what is sent, and
 * Hack Club's scraping policy permits training on Slack messages only with
 * every author's explicit consent — a kyto turn carries other people's
 * messages. Ox Alpha's provider explicitly states a ZERO-RETENTION policy and
 * does not use traffic for training (Zen docs, checked 2026-08-21), so the
 * objection has no purchase HERE specifically. Every other Zen free slug stays
 * banned; if this slug is ever served under different terms, drop it the same
 * day. See MODELS.md.
 *
 * Modality UNVERIFIED for a stealth model, so it sits in TEXT_ONLY_MODELS:
 * images are pre-described by Gemini rather than risking a doomed image turn.
 */
export const PRIMARY_MODEL = 'x-preview-f-free';

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

// Models that CANNOT accept image input. deepseek-v4-flash is served by
// Cloudflare, which is text-only: any turn carrying an image 404s ("No
// endpoints found that support image input") and burns a doomed attempt before
// falling back. x-preview-f-free's modality is UNVERIFIED (a stealth model), so
// it is treated the same rather than risk a 404 per image turn. For either, kyto
// pre-describes the image with Gemini (see vision.ts) and feeds the description
// as text instead of the raw pixels. Verify Ox Alpha with a real image call
// before removing it from this set.
const TEXT_ONLY_MODELS = new Set<string>([FORMER_PRIMARY_MODEL, PRIMARY_MODEL]);

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
 * The attempt the main query starts on: Ox Alpha on Zen when OPENCODE_API_KEY
 * is set; otherwise the former primary on HackClub, exactly as before
 * 2026-08-21. HackClub is always configured, so this never degrades to nothing.
 */
export const PRIMARY_ATTEMPT: ModelAttempt = env.OPENCODE_API_KEY
  ? {
      apiKey: env.OPENCODE_API_KEY,
      baseURL: OPENCODE_BASE_URL,
      model: PRIMARY_MODEL,
      provider: OPENCODE_PROVIDER,
    }
  : catalogAttempt(FORMER_PRIMARY_MODEL);

/**
 * Where `upgradeModel` sends a turn: the rungs kyto escalates to when the model
 * itself says the task is beyond it (owner's call, 2026-08-05 — "model self
 * escalate whenever needed … anyone can escalate it").
 *
 * These are DEAR. kimi-k3 is $3/M in and $15/M out against a FREE Zen primary
 * (and ~20x/50x the HackClub rungs behind it) — and the whole HackClub tier
 * shares one $3/day cap, so a single long escalated turn can eat most of a
 * day's budget.
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

// The models a subagent runs on: **the same model the main turn runs on**
// (owner's call, 2026-08-21 — "subagent use same deepseek v4 flash"), i.e.
// PRIMARY_ATTEMPT itself — it followed the primary from HackClub's deepseek to
// Zen's Ox Alpha when that was promoted, and follows whatever comes next. A
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
// Gemini key first and only falls to HackClub (the FORMER primary, not the Zen
// promo) if there is no Gemini key at all. Owner's call, 2026-08-21.
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
  // The DEMOTED primary (2026-08-01 → 2026-08-21): Ox Alpha on Zen leads the
  // turn now, and when that fails this is where the walk lands. Three weeks as
  // primary with no quality complaints, verified `tools`-capable, and it costs
  // nothing extra to reach since the HackClub tier is tried anyway.
  catalogAttempt(FORMER_PRIMARY_MODEL),
  // Qwen3.7 Plus ($0.32/M in, $1.28/M out, 1M ctx) — primary until deepseek
  // v4-flash was promoted over it (2026-08-01), demoted one place again by the
  // Zen promotion (2026-08-21). It held the primary slot for weeks with no
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
