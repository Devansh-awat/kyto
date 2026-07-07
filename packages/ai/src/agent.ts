import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, streamText, type ToolSet } from 'ai';
import {
  ALLOWED_MODELS,
  COST_QUALITY_TRADEOFF,
  MAX_OUTPUT_TOKENS,
  type ModelAttempt,
  ROUTER_MODEL,
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

const AUTO_ROUTER_PLUGIN_ID = 'auto-router';
const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// The resolved slug appears in the first SSE chunk; don't scan forever.
const MAX_SCAN_BYTES = 16_384;

/**
 * Stream one model attempt: the whole multi-step agentic loop on a single
 * OpenAI-compatible endpoint. The per-instance `fetch` (no global patching —
 * the old interceptor died with Pi) tunes the request:
 *  - `openrouter/auto` gets the auto-router plugin (cost_quality_tradeoff +
 *    exact-slug allowed_models allowlist);
 *  - HackClub requests get `reasoning: { effort: 'medium' }` (the old Pi
 *    thinking level) — max_tokens comes from maxOutputTokens below, which is
 *    what defuses OpenRouter's pessimistic daily-spend projection;
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
    ...(attempt.provider === 'hackclub'
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
    if (payload.model === ROUTER_MODEL) {
      const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
      payload.plugins = [
        ...plugins.filter(
          (plugin: { id?: string }) => plugin?.id !== AUTO_ROUTER_PLUGIN_ID
        ),
        {
          allowed_models: ALLOWED_MODELS,
          cost_quality_tradeoff: COST_QUALITY_TRADEOFF,
          id: AUTO_ROUTER_PLUGIN_ID,
        },
      ];
      changed = true;
    }
    if (attempt.provider === 'hackclub' && payload.reasoning === undefined) {
      payload.reasoning = { effort: 'medium' };
      changed = true;
    }
    return changed ? JSON.stringify(payload) : null;
  } catch {
    return null;
  }
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
