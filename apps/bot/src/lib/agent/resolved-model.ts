import { AsyncLocalStorage } from 'node:async_hooks';
import logger from '@/lib/logger';

// `openrouter/auto` lets OpenRouter pick the underlying model server-side. The
// Pi/harness stream only reports the *requested* id, so the concrete model it
// resolved to (e.g. `openai/gpt-5.5`) is invisible to us. But Pi makes its model
// calls through the process-global `fetch` (undici), and the proxy response —
// like any OpenAI-compatible payload — carries the resolved slug in its `model`
// field. We intercept fetch, read that field off a clone of the response, and
// stash it on a per-turn holder so the agent loop can surface it in the Model
// task. Best-effort: any failure just leaves the holder empty.

export interface ModelHolder {
  model?: string;
}

const store = new AsyncLocalStorage<ModelHolder>();

const COMPLETIONS_HINT = '/chat/completions';
const MODEL_FIELD = /"model"\s*:\s*"([^"]+)"/;
// Read at most this many bytes of the response before giving up on finding the
// model field — the slug appears in the first SSE chunk, so this is generous.
const MAX_SCAN_BYTES = 16_384;

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

let installed = false;

/** Patch global fetch once to capture the resolved model per active turn. */
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
    const response = await original(
      input as Parameters<typeof original>[0],
      init
    );
    const holder = store.getStore();
    if (
      !(holder && response.body) ||
      holder.model ||
      !requestUrl(input).includes(COMPLETIONS_HINT)
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
