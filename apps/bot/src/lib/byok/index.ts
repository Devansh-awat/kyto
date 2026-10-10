import {
  type ByokProviderId,
  byokAttempt,
  isByokProviderId,
  type ModelAttempt,
} from '@repo/ai';
import {
  getUserCustomization,
  listUserModelCredentialSecrets,
  type ModelMode,
  setCredentialValidation,
} from '@repo/db/queries';
import { byokConfigured, decryptSecret } from '@/lib/byok/crypto';
import { resolveChatgptRouting } from '@/lib/chatgpt';
import logger from '@/lib/logger';
import { assertPublicHost } from '@/lib/public-url';
import { registerSecret } from '@/lib/redact';
import { deepErrorText, errorStatus } from '@/lib/utils/error';

/**
 * How the acting user's turn is routed. "Own" attempts are the ones the user
 * pays for: a linked ChatGPT account (their subscription) plus any BYOK keys.
 */
export interface UserRouting {
  /** The user's own paid attempts, in order. Empty = an ordinary service turn. */
  own: ModelAttempt[];
  /**
   * Run the user's own attempts BEFORE kyto's shared models (true, the default —
   * their subscription/key pays), or only AFTER the shared chain is exhausted
   * (false). Set from a linked ChatGPT account's "ChatGPT first / shared first"
   * choice; BYOK-only users are always own-first, as before.
   */
  ownFirst: boolean;
  /**
   * May kyto spend the SHARED service budget after the user's own attempts fail?
   * Opt-in and OFF by default: a broken personal key/login must not silently bill
   * the shared HackClub budget. Always true when the user has no own
   * attempts at all (an ordinary service turn), and irrelevant when ownFirst is
   * false (the shared chain already runs first in that mode).
   */
  serviceFallback: boolean;
  /**
   * 'coding' = kyto's shared models, switching to the person's own attempts
   * only when the turn is caught doing coding-agent work (owner's ask,
   * 2026-09-29). The own list is populated for it, but routing leads with the
   * shared chain and the anti-coding monitor is what moves the turn over.
   */
  switchOnCoding: boolean;
}

const SERVICE_ONLY: UserRouting = {
  own: [],
  ownFirst: true,
  serviceFallback: true,
  switchOnCoding: false,
};

/**
 * Resolve how THIS user's turn should be routed: a linked ChatGPT account and
 * their own BYOK keys ("own" attempts), the order they run relative to kyto's
 * shared models, and whether the shared chain may be used at all.
 *
 * A key that can't be decrypted (encryption key rotated, row tampered) is
 * skipped rather than failing the turn — the user still gets an answer, and the
 * row is marked invalid so the App Home tab tells them to re-add it.
 */
export async function resolveUserRouting({
  model,
  userId,
}: {
  /**
   * A slug this person picked with `--model`: tried first on each of their own
   * providers (which one serves it is unknown), then their usual attempts.
   */
  model?: string;
  userId: string;
}): Promise<UserRouting> {
  if (!byokConfigured()) {
    return SERVICE_ONLY;
  }

  // A linked ChatGPT account leads the "own" list and carries the ordering
  // choice (ChatGPT-first vs shared-first). Token refresh happens inside.
  const chatgpt = await resolveChatgptRouting(userId).catch(() => undefined);

  const credentials = await listUserModelCredentialSecrets(userId).catch(
    (error: unknown) => {
      logger.warn(
        { err: deepErrorText(error), userId },
        '[byok] could not load model credentials; using service models'
      );
      return [];
    }
  );

  const own: ModelAttempt[] = [];
  let serviceFallback = false;
  if (chatgpt) {
    own.push(chatgpt.attempt);
    // A linked ChatGPT account uses ONE control (ChatGPT-first vs shared-first),
    // and either way the other tier is the fallback — so the shared chain is
    // always reachable when an account is linked.
    serviceFallback = true;
  }
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
    registerSecret({
      label: `a ${credential.provider} model key`,
      value: apiKey,
    });
    const attempt = byokAttempt({
      apiKey,
      baseUrl: credential.baseUrl,
      model: credential.model,
      provider: credential.provider,
    });
    if (!attempt) {
      continue;
    }
    // Re-checked every turn, not only at save: the name may since have been
    // re-pointed at an address inside kyto's network.
    if (credential.baseUrl) {
      const blocked = await assertPublicHost(credential.baseUrl).then(
        () => false,
        (error: unknown) => {
          logger.warn(
            { err: error, provider: credential.provider, userId },
            '[byok] base URL is not public, skipping the key'
          );
          return true;
        }
      );
      if (blocked) {
        continue;
      }
    }
    own.push(attempt);
    // Any key that opts in unlocks the service chain for the turn.
    serviceFallback ||= credential.serviceFallback;
  }

  if (own.length === 0) {
    return SERVICE_ONLY;
  }
  // An explicit pick beats the model mode: asking for a slug only their key
  // can serve is asking to spend their key, even in "kyto's models" mode.
  if (model) {
    logger.info(
      { model, providers: own.map((attempt) => attempt.provider), userId },
      '[byok] routing turn on the slug the user picked'
    );
    return {
      own: [...own.map((attempt) => ({ ...attempt, model })), ...own],
      ownFirst: true,
      serviceFallback,
      switchOnCoding: false,
    };
  }
  const mode: ModelMode =
    (await getUserCustomization(userId).catch(() => null))?.modelMode ?? 'own';
  // Kyto's models only: their keys exist but are not to be spent.
  if (mode === 'shared') {
    return SERVICE_ONLY;
  }
  if (mode === 'coding') {
    logger.info(
      { providers: own.map((attempt) => attempt.provider), userId },
      '[byok] shared models, switching to the user’s own if the turn is coding'
    );
    return {
      own,
      ownFirst: false,
      serviceFallback: true,
      switchOnCoding: true,
    };
  }
  // The ChatGPT account owns the ordering choice; a BYOK-only user is own-first.
  const ownFirst = chatgpt ? chatgpt.chatgptFirst : true;
  logger.info(
    {
      ownFirst,
      providers: own.map((attempt) => attempt.provider),
      serviceFallback,
      userId,
    },
    '[byok] routing turn on the user’s own attempts'
  );
  return { own, ownFirst, serviceFallback, switchOnCoding: false };
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
    await assertPublicHost(attempt.baseURL);
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
        redirect: 'manual',
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
