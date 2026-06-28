import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '@/lib/logger';

// `openrouter/auto` lets OpenRouter pick the underlying model server-side. Pi
// makes its model calls through the process-global `fetch` (undici), so we patch
// fetch to do two things on the completions request/response:
//
//  1. Request: tune the auto-router by injecting the `auto-router` plugin with
//     `cost_quality_tradeoff` (0 = pure quality, 7 = default, 10 = cheapest)
//     and a `model_patterns` allowlist restricting it to chosen families.
//  2. Response: the OpenAI-compatible payload carries the model the router
//     actually resolved to (e.g. `openai/gpt-5.5`) in its `model` field, which
//     the Pi/harness stream never exposes. We read it off a clone of the
//     response and stash it on a per-turn holder so the agent loop can surface
//     it in the Model task.
//
// Both are best-effort: any failure leaves the request/holder untouched.

export interface ModelHolder {
  model?: string;
}

const store = new AsyncLocalStorage<ModelHolder>();

const COMPLETIONS_HINT = '/chat/completions';
const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// Read at most this many bytes of the response before giving up on finding the
// model field — the slug appears in the first SSE chunk, so this is generous.
const MAX_SCAN_BYTES = 16_384;
// Auto-router cost/quality bias: 7 is OpenRouter's default, 10 is cheapest.
const COST_QUALITY_TRADEOFF = 5;
// Restrict the auto-router to these model families (owner-chosen allowlist).
const MODEL_PATTERNS = [
  'anthropic/*',
  'google/gemini-3*',
  'openai/gpt-*',
  'moonshot/*',
  'minimax/*',
  'zero-one-ai/*',
  'qwen/*',
];
const AUTO_ROUTER_PLUGIN_ID = 'auto-router';
const ROUTER_MODEL_ID = 'openrouter/auto';

/**
 * Begin a capture scope for the current async branch (one agent attempt) and
 * return its holder. `enterWith` persists the holder through the subsequent
 * awaits — including the streamed model call — without needing a callback, so
 * it composes with the agent's async generator (which yields across the stream).
 * Each turn runs in its own async branch, so concurrent turns stay isolated.
 */
export function enterModelCapture(): ModelHolder {
  const holder: ModelHolder = {};
  store.enterWith(holder);
  return holder;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
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
    // Ignore — capturing the model is purely cosmetic.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return;
}

function bodyToString(body: unknown): string | undefined {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return;
}

/**
 * If this is an `openrouter/auto` completions request with a JSON string body,
 * return an init with the cost-biasing auto-router plugin merged in. Otherwise
 * return the init unchanged.
 */
function tuneAutoRouter(
  url: string,
  init: RequestInit | undefined
): RequestInit | undefined {
  if (!(init?.body && url.includes(COMPLETIONS_HINT))) {
    return init;
  }
  const raw = bodyToString(init.body);
  if (!raw?.includes(ROUTER_MODEL_ID)) {
    return init;
  }
  try {
    const payload = JSON.parse(raw);
    if (payload?.model !== ROUTER_MODEL_ID) {
      return init;
    }
    const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
    payload.plugins = [
      ...plugins.filter(
        (plugin: { id?: string }) => plugin?.id !== AUTO_ROUTER_PLUGIN_ID
      ),
      {
        id: AUTO_ROUTER_PLUGIN_ID,
        cost_quality_tradeoff: COST_QUALITY_TRADEOFF,
        model_patterns: MODEL_PATTERNS,
      },
    ];
    return { ...init, body: JSON.stringify(payload) };
  } catch {
    return init;
  }
}

let installed = false;

/**
 * Patch global fetch once to (1) bias the openrouter/auto router toward cheaper
 * models and (2) capture the resolved model per active turn.
 */
export function installModelCapture(): void {
  if (installed) {
    return;
  }
  installed = true;
  const original = globalThis.fetch;
  const patched = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = requestUrl(input);
    const response = await original(
      input as Parameters<typeof original>[0],
      tuneAutoRouter(url, init)
    );
    const holder = store.getStore();
    if (
      !(holder && response.body) ||
      holder.model ||
      !url.includes(COMPLETIONS_HINT)
    ) {
      return response;
    }
    // clone() tees internally: the original is returned untouched for Pi to
    // consume; we read the copy in the background.
    const clone = response.clone();
    readResolvedModel(clone.body as ReadableStream<Uint8Array>)
      .then((model) => {
        if (model && !holder.model) {
          holder.model = model;
          logger.info({ model }, '[router] resolved openrouter/auto model');
        }
      })
      .catch(() => undefined);
    return response;
  };
  globalThis.fetch = Object.assign(patched, {
    preconnect: original.preconnect.bind(original),
  }) as typeof globalThis.fetch;
}
