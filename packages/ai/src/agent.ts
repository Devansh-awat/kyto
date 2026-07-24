import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolCallRepairFunction,
  type ToolSet,
} from 'ai';
import {
  DIGITALOCEAN_ONLY,
  DIGITALOCEAN_PROVIDER,
  GEMINI_PROVIDER,
  MAX_OUTPUT_TOKENS,
  type ModelAttempt,
} from './providers/attempts';

// Ceiling on agentic steps within one attempt (model → tools → model …).
// Effectively "no limit" for real work: a hard 60 used to strand long jobs
// (screenshotting 50 captcha frames, a big scripted scrape) mid-solve, and the
// stop looked like "kyto went quiet in the middle". The real bound on a runaway
// attempt is the wall-clock watchdog (AGENT_ATTEMPT_TIMEOUT_MS) plus the
// degenerate-loop guard, not this counter — so it's set high and overridable.
export const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS) || 1000;

/**
 * Filled in as the attempt runs: `model` is the concrete slug OpenRouter's
 * auto-router resolved to (read off the response body), `calls` counts
 * completions calls (== agentic steps).
 */
export interface ResolvedModelHolder {
  calls?: number;
  model?: string;
}

/**
 * An image the model should SEE (not just be told about). Slack image
 * attachments become these on the user turn; the viewImage tool feeds sandbox
 * screenshots in mid-turn. The openai-compatible providers only render images
 * that ride in a USER message — a tool RESULT image is JSON-stringified and lost
 * — so both paths land as user-message file parts (see below).
 */
export interface ImageInput {
  bytes: Uint8Array;
  mediaType: string;
  /** Sandbox path or filename, shown to the model as a label. */
  path?: string;
}

// An image as an AI SDK file part. Bare Uint8Array data + an image media type is
// converted to an OpenAI `image_url` by the openai-compatible provider.
function imagePart(image: ImageInput) {
  return {
    data: image.bytes,
    mediaType: image.mediaType,
    type: 'file' as const,
  };
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
  images,
  getFreshImages,
  onError,
  prompt,
  system,
  tools,
}: {
  abortSignal?: AbortSignal;
  /** Live view of the tool names exposed to the model (deferred loading). */
  activeTools?: () => string[] | undefined;
  attempt: ModelAttempt;
  holder: ResolvedModelHolder;
  /** Images to show the model on the user turn (e.g. Slack image attachments). */
  images?: ImageInput[];
  /**
   * Drained before each step for any images the model asked to view mid-turn
   * (the viewImage tool). Returns the not-yet-shown ones; they are injected as a
   * user message so the model actually sees them on the next step.
   */
  getFreshImages?: () => ImageInput[];
  /**
   * Called for every error the SDK swallows into the stream. Without it the SDK
   * default is `console.error`, which dumped an unstructured AI SDK stack blob
   * into the journal while the turn itself was logged as "complete" — the
   * failure that was impossible to attribute without a Slack transcript.
   */
  onError?: (error: unknown) => void;
  prompt: string;
  system: string;
  tools: ToolSet;
}) {
  const provider = createOpenAICompatible({
    apiKey: attempt.apiKey,
    baseURL: attempt.baseURL,
    fetch: tunedFetch({ attempt, holder }) as unknown as typeof fetch,
    // Extra per-attempt headers (e.g. the ChatGPT account-scoping header). The
    // Authorization header is still set from apiKey by the client.
    ...(attempt.headers ? { headers: attempt.headers } : {}),
    name: attempt.provider,
  });
  // Attachment images ride in the user turn (put BEFORE the text so the cache
  // breakpoint still lands on the trailing text block). With none, keep the
  // plain string prompt so the default path is byte-identical to before.
  const initialImages = images ?? [];
  const promptInput =
    initialImages.length > 0
      ? {
          messages: [
            {
              content: [
                ...initialImages.map(imagePart),
                { text: prompt, type: 'text' as const },
              ],
              role: 'user' as const,
            },
          ] satisfies ModelMessage[],
        }
      : { prompt };
  return streamText({
    ...promptInput,
    abortSignal,
    // Cap output on every metered path: HackClub (pessimistic spend projection),
    // DigitalOcean (real tokens on the owner's account), and a user's own BYOK
    // key (real tokens on THEIR account) — reasoning models otherwise burn
    // unbounded thinking tokens on someone's bill.
    ...(attempt.provider === 'hackclub' ||
    attempt.provider === DIGITALOCEAN_PROVIDER ||
    attempt.byokProvider !== undefined
      ? { maxOutputTokens: MAX_OUTPUT_TOKENS }
      : {}),
    // We run our own fallback chain across providers, so the SDK's default of 3
    // internal tries per attempt just triples the wait before we can route
    // away from a rate-limited or budget-exhausted proxy. One retry still
    // absorbs a genuinely transient blip.
    maxRetries: 1,
    // A tool call whose arguments were cut off mid-JSON (the model tried to
    // write a huge file / post a huge message and hit maxOutputTokens) otherwise
    // dies as an unrecoverable AI_JSONParseError.
    experimental_repairToolCall: repairTruncatedToolCall,
    model: provider.chatModel(attempt.model),
    ...(onError ? { onError: ({ error }) => onError(error) } : {}),
    ...(activeTools || getFreshImages
      ? {
          // Gate deferred tools per step AND inject any images the model asked to
          // view: the SDK renders images only in a user message, so a screenshot
          // the model loaded mid-turn is appended as a user turn here (the
          // override carries forward, so it stays visible on later steps).
          prepareStep: ({ messages }) => {
            const result: {
              activeTools?: never[];
              messages?: ModelMessage[];
            } = {};
            if (activeTools) {
              result.activeTools = activeTools() as never[] | undefined;
            }
            const fresh = getFreshImages?.() ?? [];
            if (fresh.length > 0) {
              const label = fresh
                .map((image) => image.path ?? 'image')
                .join(', ');
              result.messages = [
                ...messages,
                {
                  content: [
                    ...fresh.map(imagePart),
                    {
                      text: `[You are now viewing the image(s) you loaded: ${label}]`,
                      type: 'text' as const,
                    },
                  ],
                  role: 'user' as const,
                },
              ];
            }
            return result;
          },
        }
      : {}),
    stopWhen: stepCountIs(MAX_STEPS),
    system,
    tools,
  });
}

/**
 * Salvage a tool call whose argument JSON was cut off mid-stream — the model
 * tried to emit a large `content` (writeFile) or `text` (postMessage) and ran
 * into `maxOutputTokens`, so the arguments arrive as an unterminated JSON
 * fragment. The SDK's default is to throw `InvalidToolInputError`, which surfaces
 * as an unrecoverable error and strands the turn.
 *
 * Closing the open string/array/object brackets turns the fragment back into
 * valid JSON, so the call runs with the content that DID arrive rather than the
 * turn dying. The model sees the (short) result and can continue the file with
 * an append. Returns null when the fragment can't be closed into valid JSON, in
 * which case the SDK's normal error path takes over.
 */
const repairTruncatedToolCall: ToolCallRepairFunction<ToolSet> = ({
  toolCall,
}) => {
  const closed = closeTruncatedJson(toolCall.input);
  return Promise.resolve(
    closed === null ? null : { ...toolCall, input: closed }
  );
};

// Walk the fragment tracking string/escape state and the bracket stack, then
// append whatever closers are still owed. A fragment that ends mid-escape or
// mid-key is dropped back to the last safe point first.
function closeTruncatedJson(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
  }
  // A trailing backslash would escape the quote we're about to add.
  let repaired = escaped ? input.slice(0, -1) : input;
  if (inString) {
    repaired += '"';
  } else {
    // A fragment cut after a separator ("a":1,) can't be closed as-is.
    repaired = repaired.replace(/,\s*$/, '');
  }
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
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
  // Gemini 3.x attaches an encrypted `thought_signature` to every function call
  // and REQUIRES it echoed back on the next turn, or it 400s ("Function call is
  // missing a thought_signature"). The OpenAI-compat SDK drops that field when
  // it replays assistant tool calls, so we capture signatures off each response
  // (keyed by tool-call id) and re-inject them into subsequent request bodies.
  // Scoped to this attempt's closure so it persists across the attempt's steps.
  const thoughtSignatures = new Map<string, string>();
  const isGemini = attempt.provider === GEMINI_PROVIDER;
  return async (input, init) => {
    const url = requestUrl(input);
    let callInput = input;
    let callInit = init;
    if (url.includes('/chat/completions')) {
      holder.calls = (holder.calls ?? 0) + 1;
      const tuned = tuneBody(
        await readRequestBody(input, init),
        attempt,
        isGemini ? thoughtSignatures : undefined
      );
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
    if (isGemini && response.body && url.includes('/chat/completions')) {
      // Capture this response's thought signatures (background tee) so the next
      // request can echo them back — see the closure comment above.
      captureThoughtSignatures(
        response.clone().body as ReadableStream<Uint8Array>,
        thoughtSignatures
      ).catch(() => undefined);
    }
    return response;
  };
}

function tuneBody(
  raw: string | undefined,
  attempt: ModelAttempt,
  thoughtSignatures?: Map<string, string>
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
    // Gemini: re-attach captured thought signatures to assistant tool calls so
    // the API accepts the replayed history (see tunedFetch's closure comment).
    if (
      thoughtSignatures &&
      injectThoughtSignatures(payload, thoughtSignatures)
    ) {
      changed = true;
    }
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

// Re-attach captured Gemini thought signatures to the assistant tool calls in a
// request body, keyed by tool-call id. Google requires each replayed function
// call to carry the signature it was originally issued with.
function injectThoughtSignatures(
  payload: Record<string, unknown>,
  signatures: Map<string, string>
): boolean {
  if (signatures.size === 0 || !Array.isArray(payload.messages)) {
    return false;
  }
  let changed = false;
  for (const message of payload.messages as Record<string, unknown>[]) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      continue;
    }
    for (const call of message.tool_calls as Record<string, unknown>[]) {
      const id = typeof call.id === 'string' ? call.id : undefined;
      const signature = id ? signatures.get(id) : undefined;
      if (!signature) {
        continue;
      }
      const existing =
        typeof call.extra_content === 'object' && call.extra_content
          ? (call.extra_content as Record<string, unknown>)
          : {};
      call.extra_content = {
        ...existing,
        google: { thought_signature: signature },
      };
      changed = true;
    }
  }
  return changed;
}

// Max bytes to scan of a Gemini response for thought signatures — they ride on
// the tool-call delta, which is near the start, but text/reasoning can precede
// it, so allow generous headroom without reading an unbounded stream.
const MAX_SIGNATURE_SCAN_BYTES = 512 * 1024;

// Tee of a Gemini streaming response: parse SSE `data:` lines and record each
// tool call's `extra_content.google.thought_signature` by tool-call id.
async function captureThoughtSignatures(
  body: ReadableStream<Uint8Array>,
  signatures: Map<string, string>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let scanned = 0;
  try {
    while (scanned < MAX_SIGNATURE_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      scanned += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        recordSignatureLine(buffer.slice(0, newline), signatures);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  } catch {
    // Best-effort: a missed signature just re-surfaces the original 400, which
    // the fallback machinery already handles.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function recordSignatureLine(
  line: string,
  signatures: Map<string, string>
): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return;
  }
  const data = trimmed.slice('data:'.length).trim();
  if (!data || data === '[DONE]') {
    return;
  }
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return;
  }
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return;
  }
  for (const choice of choices) {
    const toolCalls = (choice as { delta?: { tool_calls?: unknown } }).delta
      ?.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const call of toolCalls) {
      const id = (call as { id?: unknown }).id;
      const signature = (
        call as {
          extra_content?: { google?: { thought_signature?: unknown } };
        }
      ).extra_content?.google?.thought_signature;
      if (typeof id === 'string' && typeof signature === 'string') {
        signatures.set(id, signature);
      }
    }
  }
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
