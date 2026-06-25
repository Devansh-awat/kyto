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

// HackClub (HACKCLUB_API_KEY @ ai.hackclub.com/proxy/v1, OpenRouter-compatible).
// NOTE: glm-5.2 and glm-4.7 currently 504 on this proxy, so they are NOT listed
// here; GLM 5.2 is still reachable via the baishui tier below. Order leads with
// models verified to return content. Re-test and re-add if HackClub fixes them.
const HACKCLUB_MODELS = [
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
// the highest daily quota so it sits before the 2.5 models.
const GEMINI_MODELS = [
  'gemini-3.5-flash',
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
