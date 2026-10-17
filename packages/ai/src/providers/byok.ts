import { GEMINI_PROVIDER, type ModelAttempt } from './attempts';

/**
 * BYOK: a user's OWN model key, used for their own turns.
 *
 * Every provider here is reached through the same OpenAI-compatible client the
 * service attempts use (`streamAttempt`), so a BYOK attempt is just another
 * `ModelAttempt` — nothing downstream needs to know whose key paid for it. The
 * catalog exists so the App Home UI can offer a base URL and a sane default
 * model per provider instead of asking a user to type an endpoint.
 */
export const BYOK_PROVIDER_IDS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'xai',
  'hackclub',
  'mebbo',
  'custom',
] as const;

// Bounds on a key owner's own output cap: below ~1k a reply barely fits, and
// above 128k most providers refuse the request outright.
export const BYOK_MIN_OUTPUT_TOKENS = 1000;
export const BYOK_MAX_OUTPUT_TOKENS = 128_000;
// A key whose owner left the cap blank. 8000 (the shared key's cap) left GLM
// 5.3 Flash, which thinks at `max` (95% of max_tokens) unless told otherwise,
// ~400 tokens to answer in: turn after turn ended on finish=length with no
// text after 1-4 minutes (#95). It's their own key; give it room.
export const BYOK_DEFAULT_OUTPUT_TOKENS = 32_000;
// At `high` the thinking takes ~80% of the cap; a blank cap is raised so the
// answer still has room (owner's call 2026-10-17).
export const BYOK_HIGH_EFFORT_OUTPUT_TOKENS = 64_000;
// The effort an OpenRouter-format key gets when its owner picked none, instead
// of the model's own default (`max` for GLM; owner's call 2026-10-17).
export const BYOK_DEFAULT_EFFORT = 'medium';
// What a key's owner can pick in App Home.
export const BYOK_EFFORTS = ['low', 'medium', 'high'] as const;

export type ByokProviderId = (typeof BYOK_PROVIDER_IDS)[number];

export interface ByokProviderSpec {
  /** OpenAI-compatible chat-completions base. Empty = user must supply one. */
  baseUrl: string;
  /** Default model id offered in the UI (the user may type another). */
  defaultModel: string;
  id: ByokProviderId;
  keyHint: string;
  label: string;
}

export const BYOK_PROVIDERS: Record<ByokProviderId, ByokProviderSpec> = {
  anthropic: {
    // Anthropic's OpenAI-compatible endpoint, so it needs no special client.
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    id: 'anthropic',
    keyHint: 'sk-ant-…',
    label: 'Anthropic',
  },
  custom: {
    baseUrl: '',
    defaultModel: '',
    id: 'custom',
    keyHint: 'any',
    label: 'Custom (OpenAI-compatible)',
  },
  // The same proxy kyto's own shared tier runs on. Offered because a Hack Club
  // member has their OWN key with their OWN daily cap — pasting it here routes
  // their turns off the shared $3/day that everyone else is also spending.
  hackclub: {
    baseUrl: 'https://ai.hackclub.com/proxy/v1',
    defaultModel: 'deepseek/deepseek-v4-flash-0731',
    id: 'hackclub',
    keyHint: 'sk-hc-…',
    label: 'Hack Club AI',
  },
  // A friend of the owner's self-hosted OpenWebUI. Free, shared limits, and
  // only worth pointing at the models that actually answer — see MODELS.md.
  mebbo: {
    baseUrl: 'https://chat.mebbo.cloud/api',
    defaultModel: 'deepseek-ai/deepseek-v4-pro',
    id: 'mebbo',
    keyHint: 'sk-…',
    label: 'mebbo (chat.mebbo.cloud)',
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-3-flash-preview',
    id: 'google',
    keyHint: 'AIza…',
    label: 'Google Gemini',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'moonshotai/kimi-k2-instruct',
    id: 'groq',
    keyHint: 'gsk_…',
    label: 'Groq',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    id: 'openai',
    keyHint: 'sk-…',
    label: 'OpenAI',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-5',
    id: 'openrouter',
    keyHint: 'sk-or-…',
    label: 'OpenRouter',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.3',
    id: 'xai',
    keyHint: 'xai-…',
    label: 'xAI',
  },
};

export function isByokProviderId(value: string): value is ByokProviderId {
  return (BYOK_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * The provider string carried on a BYOK `ModelAttempt`. Namespaced so it can
 * never collide with a service provider (`hackclub`, `gemini`)
 * in `failedKeys` or in a log — EXCEPT for Google, which is deliberately mapped
 * onto `GEMINI_PROVIDER` because Gemini's mandatory `thought_signature` replay
 * (see agent.ts) keys off exactly that string. A BYOK Gemini key needs it too.
 */
export function byokProviderName(id: ByokProviderId): string {
  return id === 'google' ? GEMINI_PROVIDER : `byok-${id}`;
}

/** True for any attempt paid for by a user's own key. */
export function isByokAttempt(attempt: ModelAttempt): boolean {
  return attempt.byokProvider !== undefined;
}

/**
 * Build the attempt for one stored credential. `baseUrl` overrides the catalog
 * default (required for `custom`, optional elsewhere — e.g. a corporate proxy).
 */
export function byokAttempt(input: {
  apiKey: string;
  baseUrl?: string | null;
  maxOutputTokens?: number | null;
  model: string;
  provider: ByokProviderId;
  reasoningEffort?: string | null;
}): ModelAttempt | undefined {
  const baseURL =
    input.baseUrl?.trim() || BYOK_PROVIDERS[input.provider].baseUrl;
  if (!(baseURL && input.model && input.apiKey)) {
    return;
  }
  return {
    apiKey: input.apiKey,
    baseURL,
    byokProvider: input.provider,
    ...(input.maxOutputTokens
      ? { maxOutputTokens: input.maxOutputTokens }
      : {}),
    model: input.model,
    provider: byokProviderName(input.provider),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
  };
}
