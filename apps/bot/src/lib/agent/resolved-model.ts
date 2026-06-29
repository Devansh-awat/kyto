import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '@/lib/logger';

// `openrouter/auto` lets OpenRouter pick the underlying model server-side. Pi
// makes its model calls through the process-global `fetch` (undici), so we patch
// fetch to do two things on the completions request/response:
//
//  1. Request: tune the auto-router by injecting the `auto-router` plugin with
//     `cost_quality_tradeoff` (0 = pure quality, 7 = default, 10 = cheapest)
//     and an `allowed_models` allowlist restricting it to chosen model ids.
//  2. Response: the OpenAI-compatible payload carries the model the router
//     actually resolved to (e.g. `openai/gpt-5.5`) in its `model` field, which
//     the Pi/harness stream never exposes. We read it off a clone of the
//     response and stash it on a per-turn holder so the agent loop can surface
//     it in the Model task.
//
// Both are best-effort: any failure leaves the request/holder untouched.

export interface ModelHolder {
  // Count of model completions calls in this turn. One call == one agentic step
  // (model → tools → model → …). Lets us tell "Pi only ran a single step" apart
  // from "the model chose to stop early" when a turn ends with no reply.
  calls?: number;
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
// Restrict the auto-router to these EXACT model ids (owner-chosen allowlist,
// derived from the leaderboard ranking). Passed as the auto-router plugin's
// `allowed_models` field (NOT `model_patterns` — that field name is silently
// ignored). Exact slugs — not globs — so trimmed variants like
// `-nano`/`-mini`/`-flash-lite`/`-fast`/`-pro-image` and `claude-fable-5` can
// never be routed to. Reasoning-effort tiers in the leaderboard
// ("Thinking"/"High"/"xHigh"/"Max") are the same slug, so they collapse.
// Verified honored by the HackClub proxy (June 2026). The lower-ranked tail
// (deepseek-v4-pro/flash, kimi-k2.6/k2.7-code, minimax-m3, qwen3.6-plus) was
// dropped to keep routing on the stronger models only.
const ALLOWED_MODELS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'z-ai/glm-5.2',
  'z-ai/glm-5.1',
  'google/gemini-3.5-flash',
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
 * If `raw` is an `openrouter/auto` completions body, return a new JSON body with
 * the cost-biasing auto-router plugin (cost_quality_tradeoff + allowed_models
 * allowlist) merged in. Returns null when it does not apply or cannot be parsed.
 */
function tuneCompletionsBody(raw: string | undefined): string | null {
  if (!raw?.includes(ROUTER_MODEL_ID)) {
    return null;
  }
  try {
    const payload = JSON.parse(raw);
    if (payload?.model !== ROUTER_MODEL_ID) {
      return null;
    }
    const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
    payload.plugins = [
      ...plugins.filter(
        (plugin: { id?: string }) => plugin?.id !== AUTO_ROUTER_PLUGIN_ID
      ),
      {
        id: AUTO_ROUTER_PLUGIN_ID,
        cost_quality_tradeoff: COST_QUALITY_TRADEOFF,
        allowed_models: ALLOWED_MODELS,
      },
    ];
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * Read the request body whether it lives on `init.body` (string/Uint8Array) or
 * inside a `Request` object passed as `input`. The AI SDK/Pi may use either, and
 * if we only checked `init.body` the plugin injection would silently no-op for
 * `Request`-style calls (the bug that let openrouter/auto pick off-allowlist
 * models like gemini-2.5-flash-lite).
 */
async function readRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<string | undefined> {
  const fromInit = bodyToString(init?.body);
  if (fromInit !== undefined) {
    return fromInit;
  }
  if (input instanceof Request) {
    return await input
      .clone()
      .text()
      .catch(() => undefined);
  }
  return;
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
    // Inject the auto-router allowlist into the openrouter/auto request. The
    // body may live on init.body OR inside a Request object, so read both and,
    // when we tune it, re-issue as (url, init) so the new body is the one sent.
    let callInput: string | URL | Request = input;
    let callInit = init;
    if (url.includes(COMPLETIONS_HINT)) {
      const tuned = tuneCompletionsBody(await readRequestBody(input, init));
      if (tuned) {
        const source =
          init?.headers ??
          (input instanceof Request ? input.headers : undefined);
        // Drop Content-Length: our tuned body is longer than the original, so a
        // stale length truncates the request on the wire — cutting off the
        // appended `plugins` (which is why the allowlist was silently ignored).
        // Let undici recompute it from the new body.
        const headers = new Headers(
          source as ConstructorParameters<typeof Headers>[0]
        );
        headers.delete('content-length');
        const method =
          init?.method ?? (input instanceof Request ? input.method : 'POST');
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        callInput = url;
        callInit = { ...init, body: tuned, headers, method, signal };
      }
    }
    const holderForCount = store.getStore();
    if (holderForCount && url.includes(COMPLETIONS_HINT)) {
      holderForCount.calls = (holderForCount.calls ?? 0) + 1;
      logger.info(
        { step: holderForCount.calls },
        '[router] model completions call'
      );
    }
    const response = await original(
      callInput as Parameters<typeof original>[0],
      callInit
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
