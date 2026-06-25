import { keys } from '../keys';
import type { PiAttempt } from '../types/providers';

const env = keys();

const HACKCLUB_BASE_URL = 'https://ai.hackclub.com/proxy/v1';
const GEMINI_BASE_URL =
  env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export const GEMINI_PROVIDER = 'gemini';

// Curated fallback order, best-first. We deliberately do NOT fan out through
// every available model — just a few strong ones per provider:
//   1) HackClub (HACKCLUB_API_KEY) — Kimi first (preferred over MiniMax), then GLM
//   2) baishui  (OPENROUTER_API_KEY @ OPENROUTER_BASE_URL) — Kimi
//   3) Gemini   (GEMINI_API_KEY) — a couple of good Flash/Pro models, last resort
// On any error the agent advances to the next entry (see lib/ai/attempts.ts).

const HACKCLUB_MODELS = [
  'moonshotai/kimi-k2.7-code',
  'moonshotai/kimi-k2.6',
  'z-ai/glm-4.7',
] as const;

const BAISHUI_MODELS = ['kimi-k2.6'] as const;

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'] as const;

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
