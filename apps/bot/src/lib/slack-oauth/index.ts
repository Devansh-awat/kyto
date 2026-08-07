import { randomBytes } from 'node:crypto';
import { getSlackGrantSecret, upsertSlackGrant } from '@repo/db/queries';
import { env } from '@/env';
import { byokConfigured, encryptSecret } from '@/lib/byok';
import { decryptSecret } from '@/lib/byok/crypto';
import logger from '@/lib/logger';

/**
 * "Connect your Slack account" — a per-user OAuth grant.
 *
 * kyto's bot token can only ever act as kyto, and some things it is asked to do
 * are only possible AS THE PERSON. The first is `!secret`: deleting the message
 * someone asked a private question in, which Slack allows only with that
 * person's own token (a bot token can delete only the bot's own messages, and
 * an admin token would attribute every deletion to the owner).
 *
 * Gated on the SAME secret as BYOK (`BYOK_ENCRYPTION_KEY`) plus
 * `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`: a user token is a credential, and a
 * credential is never stored in the clear. With any of them unset the whole
 * feature is simply absent — no App Home section, no routes, and `!secret`
 * says so rather than half-working.
 *
 * Mounted on the sites Bun.serve, which is the only public HTTP kyto has.
 */

export const SLACK_OAUTH_PREFIX = '/_slackauth/';

// How long an authorize link stays usable. Long enough to read the Slack
// consent screen and think about it, short enough that a link pasted somewhere
// by accident is not a standing invitation to bind someone else's account.
const STATE_TTL_MS = 15 * 60 * 1000;

// What kyto asks each person for. `chat:write` is what `!secret` needs (delete
// your own message); the rest are the capabilities the owner asked to unlock
// next — searching YOUR channels without kyto's short-lived assistant token,
// sending as you (behind the same confirm click as every other outward post),
// and reading a private conversation you point it at.
const USER_SCOPES = [
  'chat:write',
  'groups:history',
  'im:history',
  'im:write',
  'mpim:history',
  'search:read',
] as const;

export function slackOauthConfigured(): boolean {
  return Boolean(
    byokConfigured() && env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET
  );
}

interface OauthState {
  /** Epoch ms after which this link is dead. */
  expiry: number;
  nonce: string;
  userId: string;
}

/**
 * The `state` parameter, encrypted with the bot's own key.
 *
 * It carries the Slack user id the link was minted for, and the callback
 * REQUIRES it to match the account Slack says authorized. Without that, anyone
 * who got hold of a link could bind THEIR token to someone else's kyto identity
 * — which is the whole grant, since every later use is keyed on the Slack user
 * id. Encryption (rather than a signature) also keeps the id out of a URL that
 * lands in browser history and referrer logs.
 */
function encodeState(userId: string): string {
  const state: OauthState = {
    expiry: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(12).toString('base64url'),
    userId,
  };
  return encodeURIComponent(encryptSecret(JSON.stringify(state)));
}

function decodeState(raw: string | null): OauthState | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(decryptSecret(raw)) as Partial<OauthState>;
    if (
      typeof parsed.userId !== 'string' ||
      typeof parsed.expiry !== 'number'
    ) {
      return null;
    }
    if (Date.now() > parsed.expiry) {
      return null;
    }
    return parsed as OauthState;
  } catch {
    return null;
  }
}

function redirectUri(): string {
  return `https://${env.SITES_PUBLIC_HOST}${SLACK_OAUTH_PREFIX}callback`;
}

/** The link a user clicks to connect their Slack account to kyto. */
export function slackAuthorizeUrl(userId: string): string | null {
  if (!slackOauthConfigured()) {
    return null;
  }
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID ?? '');
  url.searchParams.set('user_scope', USER_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri());
  // Set raw: encodeState already percent-encodes, and URLSearchParams would
  // encode it a second time.
  url.searchParams.set('state', 'STATE');
  return url.toString().replace('state=STATE', `state=${encodeState(userId)}`);
}

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">${title}</h1><p>${body}</p></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status }
  );
}

/**
 * Serve the OAuth callback, or return null when the path isn't ours (so the
 * sites server falls through to static hosting).
 *
 * There is deliberately no `start` route: the authorize URL is handed to the
 * person directly, ephemerally, in Slack. A public "start" endpoint would let
 * anyone mint a link for any user id.
 */
export async function handleSlackOauth(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (pathname !== `${SLACK_OAUTH_PREFIX}callback`) {
    return null;
  }
  if (!slackOauthConfigured()) {
    return page('Not available', 'kyto is not configured for this.', 404);
  }
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    return page('Cancelled', `Slack said: ${escapeHtml(error)}.`, 400);
  }
  const state = decodeState(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!(state && code)) {
    return page(
      'Link expired',
      'That link is no longer valid. Ask kyto for a fresh one.',
      400
    );
  }
  try {
    const exchanged = await exchange(code);
    // Slack tells us which account actually authorized. If that is not the
    // person the link was minted for, this is someone binding their token to
    // another user's kyto identity — refuse rather than store it.
    if (exchanged.userId !== state.userId) {
      logger.warn(
        { authorized: exchanged.userId, expected: state.userId },
        '[slack-oauth] state/user mismatch; refusing the grant'
      );
      return page(
        'Wrong account',
        'You authorized with a different Slack account than the one that asked. Ask kyto for a new link from the account you want to connect.',
        400
      );
    }
    await upsertSlackGrant({
      encryptedToken: encryptSecret(exchanged.token),
      scopes: exchanged.scopes,
      teamId: exchanged.teamId,
      userId: exchanged.userId,
    });
    logger.info(
      { scopes: exchanged.scopes, userId: exchanged.userId },
      '[slack-oauth] account connected'
    );
    return page(
      'Connected',
      'kyto can now act as you where you ask it to. You can close this tab and go back to Slack. Disconnect any time from kyto’s App Home.',
      200
    );
  } catch (caught) {
    logger.warn({ err: caught }, '[slack-oauth] exchange failed');
    return page(
      'Something went wrong',
      'Slack would not complete the authorization. Try again from Slack.',
      502
    );
  }
}

async function exchange(code: string): Promise<{
  scopes: string;
  teamId: string;
  token: string;
  userId: string;
}> {
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID ?? '',
      client_secret: env.SLACK_CLIENT_SECRET ?? '',
      code,
      redirect_uri: redirectUri(),
    }),
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as {
    authed_user?: { access_token?: string; id?: string; scope?: string };
    error?: string;
    ok?: boolean;
    team?: { id?: string };
  };
  const user = body.authed_user;
  if (!(body.ok && user?.access_token && user.id)) {
    throw new Error(`oauth.v2.access failed: ${body.error ?? 'unknown'}`);
  }
  return {
    scopes: user.scope ?? '',
    teamId: body.team?.id ?? '',
    token: user.access_token,
    userId: user.id,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * This user's own Slack token, decrypted — or null when they haven't connected
 * an account (or the feature is off, or the stored ciphertext no longer decodes
 * because the encryption key changed).
 *
 * Never log the return value, never put it in a prompt, and never pass it into
 * a sandbox. It is a person's own Slack access, not kyto's.
 */
export async function userSlackToken(userId: string): Promise<string | null> {
  if (!slackOauthConfigured()) {
    return null;
  }
  const grant = await getSlackGrantSecret(userId).catch((error: unknown) => {
    logger.warn({ err: error, userId }, '[slack-oauth] grant read failed');
    return null;
  });
  if (!grant) {
    return null;
  }
  try {
    return decryptSecret(grant.encryptedToken);
  } catch (error) {
    logger.warn(
      { err: error, userId },
      '[slack-oauth] stored token unreadable'
    );
    return null;
  }
}

/**
 * Delete a message AS the person who wrote it.
 *
 * Only their own token can do this: kyto's bot token deletes only kyto's own
 * messages, and the owner's admin token would work but would attribute every
 * deletion to him. Returns false (never throws) so a caller can report the
 * failure instead of losing the turn to it.
 */
export async function deleteMessageAsUser({
  channel,
  ts,
  userId,
}: {
  channel: string;
  ts: string;
  userId: string;
}): Promise<boolean> {
  const token = await userSlackToken(userId);
  if (!token) {
    return false;
  }
  try {
    const response = await fetch('https://slack.com/api/chat.delete', {
      body: new URLSearchParams({ channel, ts }),
      headers: { authorization: `Bearer ${token}` },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { error?: string; ok?: boolean };
    if (!body.ok) {
      logger.warn(
        { error: body.error, userId },
        '[slack-oauth] chat.delete refused'
      );
    }
    return body.ok === true;
  } catch (error) {
    logger.warn({ err: error, userId }, '[slack-oauth] chat.delete failed');
    return false;
  }
}
