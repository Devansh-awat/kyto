import { randomBytes } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import { env } from '@/env';
import logger from '@/lib/logger';

/**
 * The host half of the owner's logged-in Slack browser (tools/slack-browser).
 *
 * kyto's user-account session (`KYTO_USER_TOKEN` + its `d` cookie) must never
 * enter a sandbox: the model has a shell there, and either value read out of it
 * is the whole account. So the sandbox's Chromium never holds them. An
 * intercepting proxy in the box (mitmproxy, see slack-browser.ts) forwards every
 * `*.slack.com` request HERE, and this end:
 *   - adds the `d` cookie, and strips any `d` Slack tries to set back;
 *   - swaps a DUMMY token for the real `xoxc-` on the way out, and the real one
 *     for the dummy in every response — the web client learns its token from
 *     the boot payload, so without this the real one would sit in the page;
 *   - refuses the calls the owner does not want made from it at all: sending,
 *     editing or deleting messages, uploads, sign-out, and channel/profile/admin
 *     changes (owner's ask, 2026-10-02: "i need a way to stop it sending").
 *
 * Every Slack byte the sandbox can produce has to pass through here — the box
 * has no cookie of its own — so the block holds for `curl` in a shell exactly
 * as it does for the browser. Owner-only: the token is minted only for an
 * owner's turn, because what this exposes is everything that account can read,
 * DMs included.
 */

export const SLACK_WEB_PREFIX = '/_slackweb/';
export const SLACK_WEB_TOKEN_HEADER = 'x-kyto-slack-web';
/** What the sandbox sees in place of the real `xoxc-` token. */
const DUMMY_SLACK_TOKEN = 'xoxc-kyto-sandbox-session-placeholder';

const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const SLACK_HOST = /^(?:[a-z0-9-]+\.)*slack\.com$/;
const SESSION_COOKIES = new Set(['d', 'd-s']);
const TEXT_TYPE = /json|text|javascript|xml|x-www-form-urlencoded/i;
// Headers that describe the bytes as they crossed the wire; `fetch` has already
// decoded the body, so passing these on would make the browser decode it twice.
const HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

// Namespaces refused whole: everything in them writes, and a new method Slack
// adds there should be refused before anyone has heard of it.
const BLOCKED_PREFIXES = [
  'admin.',
  'calls.',
  'canvases.',
  'chat.',
  'drafts.',
  'huddles.',
  'oauth.',
  'rooms.',
  'users.admin.',
  'users.profile.set',
];
// The reads inside those namespaces that the client needs to render a page.
const ALLOWED_IN_BLOCKED = new Set(['chat.getPermalink', 'drafts.list']);
const BLOCKED_METHODS = new Set([
  'apps.uninstall',
  'auth.revoke',
  'auth.signout',
  'bookmarks.add',
  'bookmarks.edit',
  'bookmarks.remove',
  'conversations.archive',
  'conversations.close',
  'conversations.convertToPrivate',
  'conversations.create',
  'conversations.delete',
  'conversations.invite',
  'conversations.inviteShared',
  'conversations.kick',
  'conversations.leave',
  'conversations.rename',
  'conversations.setPurpose',
  'conversations.setTopic',
  'conversations.unarchive',
  'emoji.add',
  'emoji.remove',
  'files.completeUploadExternal',
  'files.delete',
  'files.edit',
  'files.getUploadURLExternal',
  'files.share',
  'files.sharedPublicURL',
  'files.upload',
  'files.uploadAsync',
  'pins.add',
  'pins.remove',
  'reminders.add',
  'reminders.delete',
  'usergroups.create',
  'usergroups.disable',
  'usergroups.update',
  'usergroups.users.update',
  'users.deletePhoto',
  'users.setPhoto',
]);
// Web pages (not `/api/`) that act on GET.
const BLOCKED_PAGES =
  /^\/(?:signout|admin|customize|account\/(?:deactivate|delete))/i;
// Telemetry the client posts outside `/api/`; refusing it would only make the
// client retry, so it is accepted and dropped.
const SWALLOWED_POSTS = /^\/(?:beacon|clog)\b/;
// The client's lookups (users, channels, permissions, emoji) are POSTs to
// edgeapi's cache; refusing them as writes left the page half-loaded and the
// first click hanging.
const READ_POSTS = /^\/cache\//;

/** Whether a Web API method may be called from the logged-in browser. */
export function isSlackWebMethodAllowed(method: string): boolean {
  if (ALLOWED_IN_BLOCKED.has(method)) {
    return true;
  }
  if (BLOCKED_METHODS.has(method)) {
    return false;
  }
  return !BLOCKED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function isSlackHost(host: string): boolean {
  return SLACK_HOST.test(host);
}

/** Every occurrence of `from` in `bytes`, replaced by `to`. */
export function replaceBytes({
  bytes,
  from,
  to,
}: {
  bytes: Uint8Array;
  from: string;
  to: string;
}): Uint8Array {
  const needle = Buffer.from(from);
  const source = Buffer.from(bytes);
  const parts: Buffer[] = [];
  let start = 0;
  let at = source.indexOf(needle, start);
  if (at === -1) {
    return bytes;
  }
  const replacement = Buffer.from(to);
  while (at !== -1) {
    parts.push(source.subarray(start, at), replacement);
    start = at + needle.length;
    at = source.indexOf(needle, start);
  }
  parts.push(source.subarray(start));
  return Buffer.concat(parts);
}

/** The `d=…` header for the account, from a bare value or a full header. */
function sessionCookie(): string | undefined {
  const raw = env.KYTO_USER_COOKIE;
  if (!raw) {
    return;
  }
  return raw.includes('=') ? raw : `d=${raw}`;
}

/** Every secret value this proxy holds, so none can leave in a response. */
function secretValues(): string[] {
  const values: string[] = [];
  if (env.KYTO_USER_TOKEN) {
    values.push(env.KYTO_USER_TOKEN);
  }
  for (const part of (sessionCookie() ?? '').split(';')) {
    const value = part.split('=').slice(1).join('=').trim();
    if (value.length > 8) {
      values.push(value, decodeURIComponent(value));
    }
  }
  return values;
}

/** The browser's own cookies, minus any session cookie, plus the account's. */
export function mergeCookies({
  browser,
  session,
}: {
  browser: string | null;
  session: string;
}): string {
  const kept = (browser ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('=')[0]?.trim() ?? '';
      return part && !SESSION_COOKIES.has(name);
    });
  return [...kept, session].join('; ');
}

const tokens = new Map<string, number>();

export function slackWebConfigured(): boolean {
  return Boolean(
    env.SITES_ENABLED && env.KYTO_USER_TOKEN && env.KYTO_USER_COOKIE
  );
}

/** Mint the per-turn secret the sandbox's interceptor presents. */
export function registerSlackWebToken(): string {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, Date.now() + PROXY_TOKEN_TTL_MS);
  return secret;
}

export function revokeSlackWebToken(secret: string | undefined): void {
  if (secret) {
    tokens.delete(secret);
  }
}

function isValidToken(secret: string | null): boolean {
  if (!secret) {
    return false;
  }
  const expiry = tokens.get(secret);
  if (!expiry) {
    return false;
  }
  if (Date.now() > expiry) {
    tokens.delete(secret);
    return false;
  }
  return true;
}

function refused(reason: string): Response {
  // Slack's own shape, so the web client shows an error instead of retrying.
  return new Response(JSON.stringify({ error: reason, ok: false }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

export interface SlackWebSocketData {
  kind: 'slack-web';
  origin: string | null;
  /** Frames the browser sent before the upstream socket opened. */
  pending: string[];
  upstream?: WebSocket;
  upstreamUrl: string;
}

/** Strip the real token and cookie from text headed back into the sandbox. */
function scrub(text: string): string {
  let out = text;
  for (const value of secretValues()) {
    out = out.replaceAll(value, DUMMY_SLACK_TOKEN);
  }
  return out;
}

function withRealToken(text: string): string {
  return env.KYTO_USER_TOKEN
    ? text.replaceAll(DUMMY_SLACK_TOKEN, env.KYTO_USER_TOKEN)
    : text;
}

/**
 * Handle a forwarded Slack request, or return null if the path is not ours (so
 * a site called `_slackweb` is never shadowed for an ordinary visitor). A
 * websocket upgrade returns undefined once Bun has taken the socket over.
 */
export async function handleSlackWebProxy({
  pathname,
  request,
  server,
}: {
  pathname: string;
  request: Request;
  server: Pick<Server<SlackWebSocketData>, 'upgrade'>;
}): Promise<Response | null | undefined> {
  if (!pathname.startsWith(SLACK_WEB_PREFIX)) {
    return null;
  }
  if (!isValidToken(request.headers.get(SLACK_WEB_TOKEN_HEADER))) {
    return null;
  }
  const session = sessionCookie();
  if (!(session && env.KYTO_USER_TOKEN)) {
    return refused('kyto_session_not_configured');
  }
  const rest = pathname.slice(SLACK_WEB_PREFIX.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '/' : rest.slice(slash);
  if (!isSlackHost(host)) {
    return new Response('Not a Slack host', { status: 403 });
  }
  const { search } = new URL(request.url);
  const query = withRealToken(search);

  const apiMethod = path.startsWith('/api/')
    ? decodeURIComponent(path.slice('/api/'.length).split('/')[0] ?? '')
    : undefined;
  if (apiMethod !== undefined && !isSlackWebMethodAllowed(apiMethod)) {
    logger.info({ host, method: apiMethod }, '[slack-web] refused a call');
    return refused(
      `blocked_by_kyto: ${apiMethod} is not allowed from kyto's browser`
    );
  }
  if (apiMethod === undefined && BLOCKED_PAGES.test(path)) {
    logger.info({ host, path }, '[slack-web] refused a page');
    return new Response('Blocked by kyto', { status: 403 });
  }
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  if (
    apiMethod === undefined &&
    !readOnly &&
    request.method !== 'OPTIONS' &&
    !(host === 'edgeapi.slack.com' && READ_POSTS.test(path))
  ) {
    if (SWALLOWED_POSTS.test(path)) {
      return new Response(null, { status: 204 });
    }
    logger.info(
      { host, method: request.method, path },
      '[slack-web] refused a non-API write'
    );
    return new Response('Blocked by kyto', { status: 403 });
  }

  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const upgraded = server.upgrade(request, {
      data: {
        kind: 'slack-web',
        origin: request.headers.get('origin'),
        pending: [],
        upstreamUrl: `wss://${host}${path}${query}`,
      },
    });
    return upgraded
      ? undefined
      : new Response('Upgrade failed', { status: 400 });
  }

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      lower === 'host' ||
      lower === 'cookie' ||
      lower === SLACK_WEB_TOKEN_HEADER ||
      lower.startsWith('x-forwarded-') ||
      HOP_HEADERS.has(lower)
    ) {
      continue;
    }
    headers.set(name, withRealToken(value));
  }
  headers.set(
    'cookie',
    mergeCookies({ browser: request.headers.get('cookie'), session })
  );
  const body = readOnly
    ? undefined
    : replaceBytes({
        bytes: new Uint8Array(await request.arrayBuffer()),
        from: DUMMY_SLACK_TOKEN,
        to: env.KYTO_USER_TOKEN,
      });

  let upstream: Response;
  try {
    upstream = await fetch(`https://${host}${path}${query}`, {
      body,
      headers,
      method: request.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, host, path }, '[slack-web] upstream failed');
    return new Response('Upstream failed', { status: 502 });
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (lower === 'set-cookie' || HOP_HEADERS.has(lower)) {
      continue;
    }
    out.set(name, scrub(value));
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    const name = cookie.split('=')[0]?.trim() ?? '';
    if (!SESSION_COOKIES.has(name)) {
      out.append('set-cookie', cookie);
    }
  }
  const type = upstream.headers.get('content-type') ?? '';
  const responseBody = TEXT_TYPE.test(type)
    ? scrub(await upstream.text())
    : await upstream.arrayBuffer();
  return new Response(responseBody, {
    headers: out,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

/** An outgoing websocket frame that would send a message. */
function isSendFrame(frame: string): boolean {
  try {
    const parsed: unknown = JSON.parse(frame);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === 'message'
    );
  } catch {
    return false;
  }
}

function relayToUpstream(
  socket: ServerWebSocket<SlackWebSocketData>,
  frame: string
): void {
  if (isSendFrame(frame)) {
    logger.info('[slack-web] dropped a message frame on the socket');
    return;
  }
  const upstream = socket.data.upstream;
  if (upstream?.readyState === WebSocket.OPEN) {
    upstream.send(withRealToken(frame));
  } else {
    socket.data.pending.push(frame);
  }
}

export function isSlackWebSocket(
  socket: ServerWebSocket<SlackWebSocketData | object>
): socket is ServerWebSocket<SlackWebSocketData> {
  return 'kind' in socket.data && socket.data.kind === 'slack-web';
}

/** The relay between the sandbox's socket and Slack's, with the session added. */
export const slackWebSocketHandlers = {
  close(socket: ServerWebSocket<SlackWebSocketData>): void {
    socket.data.upstream?.close();
  },
  message(
    socket: ServerWebSocket<SlackWebSocketData>,
    raw: string | Buffer
  ): void {
    relayToUpstream(socket, typeof raw === 'string' ? raw : raw.toString());
  },
  open(socket: ServerWebSocket<SlackWebSocketData>): void {
    const session = sessionCookie() ?? '';
    // Bun's WebSocket takes request headers; the session rides only on this
    // host-side leg.
    const upstream = new WebSocket(socket.data.upstreamUrl, {
      headers: {
        Cookie: session,
        ...(socket.data.origin ? { Origin: socket.data.origin } : {}),
      },
    });
    socket.data.upstream = upstream;
    upstream.addEventListener('open', () => {
      for (const frame of socket.data.pending.splice(0)) {
        upstream.send(withRealToken(frame));
      }
    });
    upstream.addEventListener('message', (event) => {
      socket.send(
        typeof event.data === 'string' ? scrub(event.data) : event.data
      );
    });
    upstream.addEventListener('close', () => socket.close());
    upstream.addEventListener('error', () => socket.close());
  },
};
