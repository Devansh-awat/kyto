import { keys } from '../keys';
import type { PiAttempt } from '../types/providers';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export const GEMINI_PROVIDER = 'gemini';

// Curated ~20-model fallback, best-first for tool-calling / agentic / coding.
// Ranking informed by arena.ai (LMArena): GLM 5.2 is the strongest open model
// (coding #2, agentic #10), Qwen3.7-Max coding #10; Kimi K2.7-Code is purpose-
// built for agentic coding. No MiniMax (Kimi preferred). On any error the agent
// advances to the next entry (see apps/bot/src/lib/ai/attempts.ts).
//
// Routing: everything goes through HackClub first, then baishui as a deeper
// backup for the same model families; Gemini is last and uses the Gemini key
// (preferring the higher-limit 3.x models).

// The premium model: best quality (arena coding #2) but expensive on HackClub's
// limited daily budget, so it is only used for queries classified "complex"
// (see attemptsFor + lib/ai/classify). It also intermittently 504s on HackClub;
// when it does, the empty-completion fallback degrades to the next entry.
export const PREMIUM_MODEL = 'z-ai/glm-5.2';

// HackClub (HACKCLUB_API_KEY @ ai.hackclub.com/proxy/v1, OpenRouter-compatible).
// glm-5.2 leads (premium); glm-4.7 is omitted (persistent 504 on this proxy).
const HACKCLUB_MODELS = [
  PREMIUM_MODEL,
  'moonshotai/kimi-k2.7-code',
  'moonshotai/kimi-k2.6',
  'deepseek/deepseek-v4-pro',
  'z-ai/glm-5.1',
  'qwen/qwen3.7-max',
  'z-ai/glm-5',
  'deepseek/deepseek-v3.2',
  'openai/gpt-oss-120b',
] as const;

// baishui (OPENROUTER_API_KEY @ OPENROUTER_BASE_URL) — uses its own short ids.
const BAISHUI_MODELS = [
  'glm5.2-normal',
  'k2.7-code-normal',
  'deepseek-v4-pro',
  'kimi-k2.6',
  'glm5.1-normal',
  'deepseek-3.2',
] as const;

// Gemini (GEMINI_API_KEY) — prefer 3.x (higher rate limits); 3.1-flash-lite has
// the highest daily quota so it sits before the 2.5 models. `gemini-3.5-flash`
// is deliberately excluded: it returned an EMPTY response on 100% of observed
// attempts (both here and via the auto-router's `google/gemini-3.5-flash`
// pick) — same failure signature as the removed `gemini-3.1-pro-preview`
// (likely burns its output budget on thinking with no text emitted). Keeping
// it in the chain only wastes an attempt every single turn before falling
// through to flash-lite. Re-add only after verifying a real completion works.
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
] as const;

const hackclubAttempts: PiAttempt[] = HACKCLUB_MODELS.map((model) => ({
  customEnv: {
    OPENROUTER_API_KEY: env.HACKCLUB_API_KEY,
    OPENROUTER_BASE_URL: HACKCLUB_BASE_URL,
  },
  model,
  provider: 'hackclub',
}));

const baishuiAttempts: PiAttempt[] =
  env.OPENROUTER_API_KEY && env.OPENROUTER_BASE_URL
    ? BAISHUI_MODELS.map((model) => ({
        customEnv: {
          MOONSHOTAI_API_KEY: env.OPENROUTER_API_KEY as string,
          MOONSHOTAI_BASE_URL: env.OPENROUTER_BASE_URL as string,
        },
        model,
        provider: 'baishui',
      }))
    : [];

const geminiAttempts: PiAttempt[] = env.GEMINI_API_KEY
  ? GEMINI_MODELS.map((model) => ({
      customEnv: {
        GEMINI_API_KEY: env.GEMINI_API_KEY as string,
        GEMINI_BASE_URL,
      },
      model,
      provider: GEMINI_PROVIDER,
    }))
  : [];

export const chatAttempts: PiAttempt[] = [
  ...hackclubAttempts,
  ...baishuiAttempts,
  ...geminiAttempts,
];

if (chatAttempts.length === 0) {
  throw new Error('No Pi model attempts configured.');
}

/**
 * The ordered attempt chain to use for a query of the given complexity.
 * "complex" gets the full chain (PREMIUM_MODEL first). "simple" skips the
 * expensive HackClub premium model entirely to protect the daily budget — it
 * starts at the cheaper kimi-k2.7-code and falls back from there.
 */
export function attemptsFor(tier: 'simple' | 'complex'): PiAttempt[] {
  if (tier === 'complex') {
    return chatAttempts;
  }
  return chatAttempts.filter(
    (attempt) =>
      !(attempt.provider === 'hackclub' && attempt.model === PREMIUM_MODEL)
  );
}

// ── LLM model router ──────────────────────────────────────────────────────
// The main query always runs on a PAID model. Instead of a fixed tier chain, a
// cheap router LLM picks the best model for each query from this catalog (see
// apps/bot/src/lib/ai/router.ts). On failure it is re-asked, excluding models
// that already failed. Blurbs are sourced from each model's official catalog
// description (verified against HackClub's /models endpoint, June 2026) and
// drive the router's choice, so keep them accurate and capability-focused.
export type ModelTier = 'fast' | 'balanced' | 'capable' | 'frontier';

export interface CatalogModel {
  /** What it's good at and when the router should choose it. */
  blurb: string;
  /** Relative cost hint shown to the router (out $/1M tokens). */
  cost: string;
  id: string;
  label: string;
  tier: ModelTier;
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B',
    tier: 'fast',
    cost: '$0.10',
    blurb:
      "Meta's fast, reliable 70B instruct model. Cheapest here and streams text dependably. Choose for greetings, small talk, short factual questions, and quick lookups that need no heavy reasoning or coding.",
  },
  {
    id: 'minimax/minimax-m2.7',
    label: 'MiniMax M2.7',
    tier: 'balanced',
    cost: '$0.72',
    blurb:
      'Efficient agentic model built for autonomous, multi-step tool use at low cost. Choose for tool-driven workflows and general assistant tasks that do not need top-tier coding depth.',
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    tier: 'balanced',
    cost: '$0.87',
    blurb:
      '1.6T-param MoE (49B active) with a 1M-token context. Strong reasoning and coding at low cost — the best value for most complex reasoning, analysis, and coding tasks on a budget.',
  },
  {
    id: 'google/gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    tier: 'balanced',
    cost: '$3.00',
    blurb:
      'Fast multimodal thinking model (accepts image, audio, video, and files) with a 1M-token context and near-Pro reasoning. Choose for vision/file/long-document analysis or fast agentic chat.',
  },
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    tier: 'capable',
    cost: '$3.00',
    blurb:
      'Top-ranked open coding/agentic model (LMArena coding #2) with a 1M-token context. Choose for project-level software engineering and long-horizon agent workflows.',
  },
  {
    id: 'moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    tier: 'capable',
    cost: '$3.50',
    blurb:
      'Coding-specialist MoE built to complete end-to-end programming tasks reliably over long contexts. Choose for serious coding, debugging, or building/deploying software.',
  },
  {
    id: 'qwen/qwen3.7-max',
    label: 'Qwen3.7 Max',
    tier: 'capable',
    cost: '$3.75',
    blurb:
      "Alibaba's flagship generalist with a 1M-token context, strong at agentic work, coding, and productivity. A capable all-rounder alternative to GLM/Kimi.",
  },
  {
    id: 'openai/o4-mini',
    label: 'o4-mini',
    tier: 'capable',
    cost: '$4.40',
    blurb:
      'Compact o-series reasoning specialist (multimodal). Choose for hard math, logic puzzles, and careful step-by-step reasoning where correctness matters more than speed.',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6',
    tier: 'frontier',
    cost: '$15.00',
    blurb:
      'Frontier model for coding, agents, and professional writing, with a 1M-token context. Choose for complex, high-quality work and nuanced writing. Expensive — only when the task clearly warrants it.',
  },
  {
    id: 'anthropic/claude-opus-4.8',
    label: 'Claude Opus 4.8',
    tier: 'frontier',
    cost: '$25.00',
    blurb:
      'The most capable model available. Choose ONLY for the hardest, highest-stakes tasks where every other model would fall short. Very expensive — use sparingly.',
  },
];

export const CATALOG_IDS = MODEL_CATALOG.map((model) => model.id);

/** The default model when the router cannot choose (budget-safe, capable). */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

/**
 * The primary routing model for the main query: OpenRouter's own auto-router,
 * reached through the OpenRouter-compatible HackClub proxy. OpenRouter picks the
 * best underlying model per request, replacing our per-request router-LLM hop
 * (see apps/bot/src/lib/agent/index.ts). The MODEL_CATALOG above is retained for
 * reference/diagnostics and the deep-fallback families below.
 */
export const ROUTER_MODEL = 'openrouter/auto';

/** Build a HackClub attempt for any catalog model id. */
export function catalogAttempt(model: string): PiAttempt {
  return {
    customEnv: {
      OPENROUTER_API_KEY: env.HACKCLUB_API_KEY,
      OPENROUTER_BASE_URL: HACKCLUB_BASE_URL,
    },
    model,
    provider: 'hackclub',
  };
}

// Deep backup after the whole catalog has been exhausted: the same model
// families on baishui, then Gemini. Keeps the bot resilient if HackClub is down.
export const deepFallbackAttempts: PiAttempt[] = [
  ...baishuiAttempts,
  ...geminiAttempts,
];

/* baishui-proxy helpers — DISABLED with the baishui rungs below (the proxy's
 * upstream completions fail). Uncomment together with the LEADERBOARD_FALLBACK
 * block to re-enable.
 * const proxyAttempt = (model: string): PiAttempt => ({
 *   customEnv: {
 *     MOONSHOTAI_API_KEY: env.OPENROUTER_API_KEY as string,
 *     MOONSHOTAI_BASE_URL: env.OPENROUTER_BASE_URL as string,
 *   },
 *   model,
 *   provider: 'baishui',
 * });
 * const proxyReady = Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_BASE_URL);
 */

// The owner's arena leaderboard, best→worst, restricted to models we can
// actually reach: the strong tier on HackClub (same slugs `openrouter/auto`
// resolves to), the open-weight tail on the baishui proxy. Fable 5 (rank #1) is
// unreachable (no provider) and omitted; reasoning-effort tiers collapse to one
// slug. The agent (apps/bot/src/lib/agent/index.ts) runs `openrouter/auto`
// first, retries the exact model it resolved to, then walks THIS list UP from
// that model (toward #1) and then DOWN (toward the weakest). Order matters: the
// index of each entry is the rank used for the up/down pivot.
export const LEADERBOARD_FALLBACK: PiAttempt[] = [
  catalogAttempt('anthropic/claude-opus-4.8'),
  catalogAttempt('openai/gpt-5.5'),
  catalogAttempt('anthropic/claude-opus-4.7'),
  catalogAttempt('anthropic/claude-opus-4.6'),
  catalogAttempt('openai/gpt-5.4'),
  catalogAttempt('z-ai/glm-5.2'),
  catalogAttempt('anthropic/claude-sonnet-4.6'),
  catalogAttempt('z-ai/glm-5.1'),
  // `google/gemini-3.5-flash` deliberately omitted here too — see GEMINI_MODELS
  // above, same 100%-empty-response failure via this HackClub/OpenRouter slug.
  // baishui (jam06452.uk) is DISABLED — its /models endpoint responds but every
  // completion fails ("upstream authentication failed" / "all provider keys are
  // rate-limited or in cooldown"), so it only wastes fallback attempts. Re-enable
  // this block if the proxy's upstream is fixed (verify with a real completion,
  // not just GET /models). `proxyAttempt`/`proxyReady` are kept for that.
  // ...(proxyReady
  //   ? [
  //       proxyAttempt('deepseek-v4-pro'),
  //       proxyAttempt('kimi-k2.6'),
  //       proxyAttempt('k2.7-code-normal'),
  //       proxyAttempt('deepseek-4-flash'),
  //       proxyAttempt('m3-normal'),
  //     ]
  //   : []),
  // Last resort: the owner's OWN Gemini key (GEMINI_API_KEY, direct Google
  // endpoint — separate quota from HackClub, and very cheap). Reached after the
  // HackClub rungs fail (and immediately on a HackClub budget-exhaustion 429, see
  // buildFallbackQueue), so a fully budget-exhausted day still gets an answer.
  // Empty if the key is unset (then these rungs are simply skipped).
  ...geminiAttempts,
];
