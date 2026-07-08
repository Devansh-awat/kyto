import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, streamText, type ToolSet } from 'ai';
import {
  DIGITALOCEAN_ONLY,
  DIGITALOCEAN_PROVIDER,
  MAX_OUTPUT_TOKENS,
  type ModelAttempt,
} from './providers/attempts';

// Hard ceiling on agentic steps within one attempt (model → tools → model …).
const MAX_STEPS = 60;

/**
 * Filled in as the attempt runs: `model` is the concrete slug OpenRouter's
 * auto-router resolved to (read off the response body), `calls` counts
 * completions calls (== agentic steps).
 */
export interface ResolvedModelHolder {
  calls?: number;
  model?: string;
}

const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// The resolved slug appears in the first SSE chunk; don't scan forever.
const MAX_SCAN_BYTES = 16_384;

/**
 * Stream one model attempt: the whole multi-step agentic loop on a single
 * OpenAI-compatible endpoint. The per-instance `fetch` (no global patching —
 * the old interceptor died with Pi) tunes the request:
 *  - HackClub/DigitalOcean requests get `reasoning: { effort: 'medium' }` (the
 *    old Pi thinking level) — max_tokens comes from maxOutputTokens below,
 *    which defuses OpenRouter's pessimistic daily-spend projection;
 *  - DigitalOcean BYOK requests are pinned to the DigitalOcean provider;
 *  - every request gets 1-hour prompt-cache breakpoints (see addCacheControl);
 * and captures the resolved model slug into `holder` from a response clone.
 */
export function streamAttempt({
  abortSignal,
  activeTools,
  attempt,
  holder,
  prompt,
  system,
  tools,
}: {
  abortSignal?: AbortSignal;
  /** Live view of the tool names exposed to the model (deferred loading). */
  activeTools?: () => string[] | undefined;
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  prompt: string;
  system: string;
  tools: ToolSet;
}) {
  const provider = createOpenAICompatible({
    apiKey: attempt.apiKey,
    baseURL: attempt.baseURL,
    fetch: tunedFetch({ attempt, holder }) as unknown as typeof fetch,
    name: attempt.provider,
  });
  return streamText({
    abortSignal,
    // Cap output on metered proxies (HackClub's pessimistic spend projection;
    // DigitalOcean BYOK bills real tokens to the owner's account) — reasoning
    // models otherwise burn unbounded thinking tokens.
    ...(attempt.provider === 'hackclub' ||
    attempt.provider === DIGITALOCEAN_PROVIDER
      ? { maxOutputTokens: MAX_OUTPUT_TOKENS }
      : {}),
    model: provider.chatModel(attempt.model),
    ...(activeTools
      ? {
          prepareStep: () => ({
            activeTools: activeTools() as never[] | undefined,
          }),
        }
      : {}),
    prompt,
    stopWhen: stepCountIs(MAX_STEPS),
    system,
    tools,
  });
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

function tunedFetch({
  attempt,
  holder,
}: {
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
}): FetchLike {
  return async (input, init) => {
    const url = requestUrl(input);
    let callInput = input;
    let callInit = init;
    if (url.includes('/chat/completions')) {
      holder.calls = (holder.calls ?? 0) + 1;
      const tuned = tuneBody(await readRequestBody(input, init), attempt);
      if (tuned) {
        const source =
          init?.headers ??
          (input instanceof Request ? input.headers : undefined);
        // Recompute Content-Length: the tuned body is longer, and a stale
        // length truncates the request on the wire (silently dropping the
        // appended plugins — the old "allowlist ignored" bug).
        const headers = new Headers(
          source as ConstructorParameters<typeof Headers>[0]
        );
        headers.delete('content-length');
        callInput = url;
        callInit = {
          ...init,
          body: tuned,
          headers,
          method:
            init?.method ?? (input instanceof Request ? input.method : 'POST'),
          signal:
            init?.signal ??
            (input instanceof Request ? input.signal : undefined),
        };
      }
    }
    const response = await fetch(
      callInput as Parameters<typeof fetch>[0],
      callInit
    );
    if (response.body && !holder.model && url.includes('/chat/completions')) {
      // clone() tees: the original streams to the SDK untouched; we scan the
      // copy in the background for the resolved model slug.
      readResolvedModel(
        response.clone().body as ReadableStream<Uint8Array>
      ).then((model) => {
        if (model && !holder.model) {
          holder.model = model;
        }
      });
    }
    return response;
  };
}

function tuneBody(
  raw: string | undefined,
  attempt: ModelAttempt
): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    let changed = false;
    // DigitalOcean BYOK: the OpenRouter key has $0 credit, so force the
    // DigitalOcean provider — that's the free path billed to the owner's DO
    // account. Without this, OpenRouter tries a paid provider and 402s.
    if (attempt.provider === DIGITALOCEAN_PROVIDER) {
      const existing =
        typeof payload.provider === 'object' && payload.provider
          ? (payload.provider as Record<string, unknown>)
          : {};
      payload.provider = { ...existing, only: [DIGITALOCEAN_ONLY] };
      changed = true;
    }
    if (
      (attempt.provider === 'hackclub' ||
        attempt.provider === DIGITALOCEAN_PROVIDER) &&
      payload.reasoning === undefined
    ) {
      payload.reasoning = { effort: 'medium' };
      changed = true;
    }
    // Prompt caching: mark the large, stable prefix (system prompt + tool
    // schemas) and the moving conversation tail with cache_control breakpoints.
    // Anthropic/Gemini honor these for ~10x cheaper cached reads (verified
    // through the HackClub proxy); providers that don't support explicit
    // caching (OpenAI, DeepSeek, GLM, Kimi, …) safely ignore them and auto-cache
    // on their own. Applied to every attempt — harmless where unsupported.
    if (addCacheControl(payload)) {
      changed = true;
    }
    return changed ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
}

// A 1-hour cache breakpoint. Anthropic (and OpenRouter's passthrough to it)
// accept `ttl: '1h'` to extend the default 5-minute ephemeral cache to an hour,
// so the big system+tools prefix stays cached across a thread's sporadic turns
// (not just within one multi-step loop). Providers without extended TTL ignore
// the field; a bare `{ type: 'ephemeral' }` would just fall back to 5 minutes.
const CACHE_CONTROL = { ttl: '1h', type: 'ephemeral' } as const;

// Attach the cache breakpoint to a message's last text block, converting a
// string body to the content-array form OpenRouter expects. Leaves
// non-text/assistant/tool messages untouched (only called on system and user
// messages, whose content the SDK sends as plain strings).
function markCacheBreakpoint(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) {
      return false;
    }
    message.content = [
      { cache_control: CACHE_CONTROL, text: content, type: 'text' },
    ];
    return true;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content.at(-1);
    if (last && typeof last === 'object') {
      (last as Record<string, unknown>).cache_control = CACHE_CONTROL;
      return true;
    }
  }
  return false;
}

// Two breakpoints, both on stable content: the last system message (caches the
// tools + system prefix — the big constant chunk) and the last user message
// (extends the cached prefix over the replayed thread history). Within a
// multi-step tool loop these two stay fixed, so every step reads the cached
// prefix instead of re-billing it. Anthropic allows up to 4 breakpoints; two is
// safe. Providers without explicit caching ignore the field.
function addCacheControl(payload: Record<string, unknown>): boolean {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  const reversed = [...messages].reverse() as Record<string, unknown>[];
  let changed = false;
  const lastSystem = reversed.find((m) => m.role === 'system');
  if (lastSystem && markCacheBreakpoint(lastSystem)) {
    changed = true;
  }
  const lastUser = reversed.find((m) => m.role === 'user');
  if (lastUser && lastUser !== lastSystem && markCacheBreakpoint(lastUser)) {
    changed = true;
  }
  return changed;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function readRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (input instanceof Request) {
    return await input
      .clone()
      .text()
      .catch(() => undefined);
  }
  return;
}

async function readResolvedModel(
  body: ReadableStream<Uint8Array>
): Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let scanned = '';
  try {
    while (scanned.length < MAX_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += decoder.decode(value, { stream: true });
      const match = scanned.match(MODEL_FIELD);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Capturing the model is purely cosmetic.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return;
}
