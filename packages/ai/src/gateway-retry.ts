/**
 * Transparent retry for GATEWAY failures — a response the model never saw.
 *
 * HackClub's edge answers roughly one request in six with a 504 HTML error
 * page, always ~5s in and regardless of prompt size (measured 2026-07-27: 3 of
 * 17 probe requests, 300-byte and 70KB bodies alike, while the same slug served
 * every other request fine). A multi-step turn issues one request per step, so
 * at that rate a long turn nearly always lost a step somewhere — and the agent
 * loop, which cannot tell "the proxy dropped one request" from "this model just
 * died", abandoned a healthy primary MID-TASK and walked the fallback all the
 * way down to gemini-flash-lite.
 *
 * A gateway status is the one failure that is safe to replay verbatim: it came
 * from the proxy, not the model, so nothing was generated, nothing was billed,
 * and not one completion byte has streamed. Everything else — any 4xx, a
 * 429/budget, a stream that dies after it started — is left alone and still
 * routes away on the first failure, which is why `maxRetries` stays at 1 in
 * agent.ts. Retrying a rate-limited or budget-exhausted proxy only delays the
 * fallback; retrying a dropped connection is the whole fix.
 *
 * One 429 is replayed too (owner's call 2026-10-20, for Mercury 3): OpenRouter's
 * "temporarily rate-limited upstream" from a provider's SHARED pool — another
 * tenant's burst, nothing to do with kyto's budget, and gone seconds later.
 * Mercury's pool answered half the probes that way on its first days. A 429
 * that says a quota or budget is spent is still left alone.
 */

/**
 * Statuses that mean "the edge gave up", never "the model refused": the
 * standard gateway trio, a request timeout, and Cloudflare's origin-side codes
 * (HackClub's 504 arrives as a Cloudflare error page).
 */
const GATEWAY_STATUSES = new Set([408, 502, 503, 504, 520, 522, 524]);

/**
 * Two retries — three sends in total. At the observed ~1-in-6 failure rate that
 * takes a step's chance of dying from ~17% to ~0.5%, while a proxy that is
 * genuinely down still costs at most ~16s (three ~5s timeouts plus backoff)
 * before the turn gives up on it and falls back to the next model.
 */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = [300, 1200];
// The shared pool needs seconds, not milliseconds, to free up. The SDK sends a failed request once more on top (maxRetries 1), so these
// run twice: 2026-10-20's first live mercury turn spent 45s on eight 429s
// with three retries here. Two keep that near 15s.
const RATE_LIMIT_RETRY_DELAY_MS = [1500, 4000];
// OpenRouter's body for that 429: `"limit_source":"upstream_provider_shared_pool"`
// and "… is temporarily rate-limited upstream. Please retry shortly".
const UPSTREAM_POOL_LIMIT =
  /upstream_provider_shared_pool|temporarily rate-limited upstream/;

export type FetchInput = string | URL | Request;

type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export interface GatewayRetryInfo {
  delayMs: number;
  /** A shared-pool 429 rather than a gateway status. */
  rateLimited?: boolean;
  /** 1-based: the retry about to be sent. */
  retry: number;
  status: number;
}

export interface GatewayRetryOptions {
  /** Injectable for tests; the global fetch otherwise. */
  fetchImpl?: FetchLike;
  onRetry?: (info: GatewayRetryInfo) => void;
  /** Injectable for tests; a real abort-aware timer otherwise. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function isGatewayStatus(status: number): boolean {
  return GATEWAY_STATUSES.has(status);
}

/**
 * Does this error text say ONE model's upstream pool is busy? That is about
 * the model, not the proxy: the next model on the same proxy is unaffected.
 */
export function isUpstreamPoolLimitText(text: string): boolean {
  return UPSTREAM_POOL_LIMIT.test(text);
}

/** Is this a 429 from a provider's shared pool, safe to send again shortly? */
export async function isUpstreamPoolLimit(
  response: Response
): Promise<boolean> {
  if (response.status !== 429) {
    return false;
  }
  const body = await response
    .clone()
    .text()
    .catch(() => '');
  return isUpstreamPoolLimitText(body);
}

/**
 * A request may only be replayed while we still hold its body: `fetch(Request)`
 * consumes the Request's stream, so a Request input is sent once and never
 * retried. The AI SDK calls us with a URL string plus a string body — the path
 * that actually matters here — and `tunedFetch` rebuilds the request that way
 * whenever it rewrites the body.
 */
export function isReplayableRequest(
  input: FetchInput,
  init: RequestInit | undefined
): boolean {
  if (input instanceof Request) {
    return false;
  }
  const body = init?.body;
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array
  );
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
};

/**
 * `fetch`, with gateway failures replayed. Returns the last response either way
 * — an exhausted retry is indistinguishable to the caller from the single
 * failure it used to get, so the existing error handling and fallback still
 * apply unchanged.
 */
export async function fetchWithGatewayRetry(
  input: FetchInput,
  init: RequestInit | undefined,
  options: GatewayRetryOptions = {}
): Promise<Response> {
  const send = options.fetchImpl ?? (fetch as FetchLike);
  const sleep = options.sleep ?? defaultSleep;
  let response = await send(input, init);
  if (!isReplayableRequest(input, init)) {
    return response;
  }
  let gatewayRetries = 0;
  let poolRetries = 0;
  while (!init?.signal?.aborted) {
    const gateway = isGatewayStatus(response.status);
    const pool = !gateway && (await isUpstreamPoolLimit(response));
    const delays = gateway ? RETRY_DELAY_MS : RATE_LIMIT_RETRY_DELAY_MS;
    const retry = gateway ? gatewayRetries + 1 : poolRetries + 1;
    const limit = gateway ? MAX_RETRIES : RATE_LIMIT_RETRY_DELAY_MS.length;
    if (!(gateway || pool) || retry > limit) {
      break;
    }
    if (gateway) {
      gatewayRetries = retry;
    } else {
      poolRetries = retry;
    }
    // Nobody reads the error page we are about to discard; cancel it so the
    // connection is released now instead of being held until the pool times out.
    await response.body?.cancel().catch(() => undefined);
    const delayMs = delays[retry - 1] ?? delays.at(-1) ?? 0;
    options.onRetry?.({
      delayMs,
      retry,
      status: response.status,
      ...(pool ? { rateLimited: true } : {}),
    });
    await sleep(delayMs, init?.signal ?? undefined);
    response = await send(input, init);
  }
  return response;
}
