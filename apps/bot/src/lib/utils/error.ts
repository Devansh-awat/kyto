export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return String(error);
}

// Depth cap: an error chain is short, and a malformed `cause` cycle must not
// hang whatever is inspecting it.
const UNWRAP_DEPTH = 4;
const BODY_KEYS = ['responseBody', 'data', 'statusCode'] as const;
const WRAPPER_KEYS = ['lastError', 'cause'] as const;

/**
 * Every scrap of text in an error chain: its message, any HTTP response body,
 * and the same for whatever it wraps.
 *
 * The unwrapping matters. The AI SDK retries internally and rethrows an
 * `AI_RetryError` whose own message is just "Failed after 3 attempts…", while
 * the upstream body that says *why* (e.g. HackClub's "Key limit exceeded (daily
 * limit)") hangs off `lastError`/`errors`. Matching a provider's failure mode
 * on the outer message alone silently misses it.
 */
export function deepErrorText(error: unknown, depth = 0): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error == null || depth > UNWRAP_DEPTH) {
    return '';
  }
  const pieces: string[] = [];
  if (error instanceof Error) {
    pieces.push(error.message);
  }
  const record = error as Record<string, unknown>;
  for (const key of BODY_KEYS) {
    const value = record[key];
    if (value != null) {
      pieces.push(typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  for (const key of WRAPPER_KEYS) {
    if (record[key] != null) {
      pieces.push(deepErrorText(record[key], depth + 1));
    }
  }
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      pieces.push(deepErrorText(nested, depth + 1));
    }
  }
  return pieces.filter(Boolean).join(' ') || String(error);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(errorMessage(error), { cause: error });
}

export function toLogError(error: unknown): { err: Error } {
  return { err: toError(error) };
}
