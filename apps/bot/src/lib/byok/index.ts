import {
  type ByokProviderId,
  byokAttempt,
  isByokProviderId,
  type ModelAttempt,
} from '@repo/ai';
import {
  listUserModelCredentialSecrets,
  setCredentialValidation,
} from '@repo/db/queries';
import { byokConfigured, decryptSecret } from '@/lib/byok/crypto';
import logger from '@/lib/logger';
import { deepErrorText, errorStatus } from '@/lib/utils/error';

export {
  byokConfigured,
  encryptSecret,
  keyPreview,
  SecretCryptoError,
} from '@/lib/byok/crypto';

/** How the acting user's turn is routed. */
export interface UserRouting {
  /** The user's own keys, in the order they were added. Empty = service turn. */
  byok: ModelAttempt[];
  /**
   * May kyto spend the SHARED service budget after the user's own keys fail?
   * Opt-in per key and OFF by default: a broken personal key must not silently
   * bill the shared HackClub/DigitalOcean budget. Always true when the user has
   * no keys at all (an ordinary service turn).
   */
  serviceFallback: boolean;
}

const SERVICE_ONLY: UserRouting = { byok: [], serviceFallback: true };

/**
 * Resolve how THIS user's turn should be routed: their own model keys first (in
 * the order added), and whether the service chain may be used after them.
 *
 * A key that can't be decrypted (encryption key rotated, row tampered) is
 * skipped rather than failing the turn — the user still gets an answer, and the
 * row is marked invalid so the App Home tab tells them to re-add it.
 */
export async function resolveUserRouting(userId: string): Promise<UserRouting> {
  if (!byokConfigured()) {
    return SERVICE_ONLY;
  }
  const credentials = await listUserModelCredentialSecrets(userId).catch(
    (error: unknown) => {
      logger.warn(
        { err: deepErrorText(error), userId },
        '[byok] could not load model credentials; using service models'
      );
      return [];
    }
  );
  if (credentials.length === 0) {
    return SERVICE_ONLY;
  }

  const byok: ModelAttempt[] = [];
  let serviceFallback = false;
  for (const credential of credentials) {
    if (!isByokProviderId(credential.provider)) {
      continue;
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(credential.encryptedKey);
    } catch (error) {
      logger.error(
        { err: deepErrorText(error), provider: credential.provider, userId },
        '[byok] could not decrypt a stored model key; skipping it'
      );
      await setCredentialValidation({
        message: 'Stored key could not be read. Re-add it.',
        provider: credential.provider,
        status: 'invalid',
        userId,
      }).catch(() => undefined);
      continue;
    }
    const attempt = byokAttempt({
      apiKey,
      baseUrl: credential.baseUrl,
      model: credential.model,
      provider: credential.provider,
    });
    if (!attempt) {
      continue;
    }
    byok.push(attempt);
    // Any key that opts in unlocks the service chain for the turn.
    serviceFallback ||= credential.serviceFallback;
  }

  if (byok.length === 0) {
    return SERVICE_ONLY;
  }
  logger.info(
    {
      providers: byok.map((attempt) => attempt.provider),
      serviceFallback,
      userId,
    },
    '[byok] routing turn on the user’s own model keys'
  );
  return { byok, serviceFallback };
}

// Statuses a provider returns when the KEY itself is the problem, as opposed to
// a transient failure (429/5xx) that says nothing about its validity.
const KEY_REJECTED_STATUSES = new Set([401, 402, 403]);

/**
 * Record what a BYOK attempt's outcome says about the key, so the owner of the
 * key sees it in App Home. Only a key-rejection status marks it invalid — a rate
 * limit or an outage must not brand a good key as broken.
 */
export async function recordByokOutcome(input: {
  attempt: ModelAttempt;
  error?: unknown;
  userId: string;
}): Promise<void> {
  const provider = input.attempt.byokProvider;
  if (!provider) {
    return;
  }
  if (!input.error) {
    await setCredentialValidation({
      provider,
      status: 'valid',
      userId: input.userId,
    }).catch(() => undefined);
    return;
  }
  const status = errorStatus(input.error);
  if (!(status && KEY_REJECTED_STATUSES.has(status))) {
    return;
  }
  await setCredentialValidation({
    message: providerRejection(input.error, status),
    provider,
    status: 'invalid',
    userId: input.userId,
  }).catch(() => undefined);
}

const REJECTION_MAX_LENGTH = 200;

function providerRejection(error: unknown, status: number): string {
  const detail = deepErrorText(error).slice(0, REJECTION_MAX_LENGTH);
  return `${status}: ${detail || 'key rejected by the provider'}`;
}

/**
 * Check a key by actually calling the provider — one tiny completion. Run when a
 * key is saved so a typo is caught immediately instead of at the next turn.
 * Returns the provider's own message on rejection, for the acting user only.
 */
export async function validateCredential(input: {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  provider: ByokProviderId;
}): Promise<{ message?: string; valid: boolean }> {
  const attempt = byokAttempt(input);
  if (!attempt) {
    return { message: 'Missing a base URL or model id.', valid: false };
  }
  try {
    const response = await fetch(
      `${trimSlash(attempt.baseURL)}/chat/completions`,
      {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: 'hi', role: 'user' }],
          model: attempt.model,
        }),
        headers: {
          Authorization: `Bearer ${attempt.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      }
    );
    if (response.ok) {
      return { valid: true };
    }
    const body = await response.text().catch(() => '');
    return {
      message: `${response.status}: ${body.slice(0, REJECTION_MAX_LENGTH) || response.statusText}`,
      valid: false,
    };
  } catch (error) {
    // A network failure says nothing about the key; don't call it invalid.
    return {
      message: `Could not reach the provider: ${deepErrorText(error).slice(0, REJECTION_MAX_LENGTH)}`,
      valid: false,
    };
  }
}

const VALIDATION_TIMEOUT_MS = 15_000;

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
