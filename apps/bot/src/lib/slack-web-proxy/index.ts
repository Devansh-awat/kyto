import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { promisify } from 'node:util';
import type { Server, ServerWebSocket } from 'bun';
import { env } from '@/env';
import logger from '@/lib/logger';

/**
 * The network half of the owner's logged-in Slack browser (lib/slack-browser).
 *
 * kyto's user-account session (`KYTO_USER_TOKEN` + its `d` cookie) must never
 * sit in the browser itself: the model reads that page (snapshots, `get html`),
 * and either value read out of it is the whole account. So the browser's
 * resolver sends every `*.slack.com` connection to a TLS listener on loopback
 * — one per session, alive only while it is — and this end:
 *   - adds the `d` cookie, and strips any `d` Slack tries to set back;
 *   - swaps a DUMMY token for the real `xoxc-` on the way out, and the real one
 *     for the dummy in every response — the web client learns its token from
 *     the boot payload, so without this the real one would sit in the page;
 *   - refuses only signing out: that would end the real session the user-account
 *     kyto runs on. Everything else goes through — owner's call, 2026-10-02:
 *     "since owner only, the proxy should allow everything".
 *
 * Owner-only: what this exposes is everything that account can read and do,
 * DMs included.
 */

/** What the browser sees in place of the real `xoxc-` token. */
const DUMMY_SLACK_TOKEN = 'xoxc-kyto-sandbox-session-placeholder';

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

const SIGN_OUT_METHODS = new Set(['auth.revoke', 'auth.signout']);
const SIGN_OUT_PAGE = /^\/signout\b/i;

const execFileAsync = promisify(execFile);

/** Whether a Web API method may be called from the logged-in browser. */
export function isSlackWebMethodAllowed(method: string): boolean {
  return !SIGN_OUT_METHODS.has(method);
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

export function slackWebConfigured(): boolean {
  return Boolean(env.KYTO_USER_TOKEN && env.KYTO_USER_COOKIE);
}

function refused(reason: string): Response {
  // Slack's own shape, so the web client shows an error instead of retrying.
  return new Response(JSON.stringify({ error: reason, ok: false }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

interface SlackWebSocketData {
  origin: string | null;
  /** Frames the browser sent before the upstream socket opened. */
  pending: string[];
  upstream?: WebSocket;
  upstreamUrl: string;
}

/** Strip the real token and cookie from text headed back into the browser. */
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

async function forward({
  request,
  server,
}: {
  request: Request;
  server: Pick<Server<SlackWebSocketData>, 'upgrade'>;
}): Promise<Response | undefined> {
  const session = sessionCookie();
  if (!(session && env.KYTO_USER_TOKEN)) {
    return refused('kyto_session_not_configured');
  }
  const url = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;
  if (!isSlackHost(host)) {
    return new Response('Not a Slack host', { status: 403 });
  }
  const query = withRealToken(url.search);

  const apiMethod = path.startsWith('/api/')
    ? decodeURIComponent(path.slice('/api/'.length).split('/')[0] ?? '')
    : undefined;
  if (
    (apiMethod !== undefined && !isSlackWebMethodAllowed(apiMethod)) ||
    (apiMethod === undefined && SIGN_OUT_PAGE.test(path))
  ) {
    logger.info({ host, path }, '[slack-web] refused signing out');
    return refused("blocked_by_kyto: signing out would end kyto's session");
  }

  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const upgraded = server.upgrade(request, {
      data: {
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
    if (lower === 'host' || lower === 'cookie' || HOP_HEADERS.has(lower)) {
      continue;
    }
    headers.set(name, withRealToken(value));
  }
  headers.set(
    'cookie',
    mergeCookies({ browser: request.headers.get('cookie'), session })
  );
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
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

/** The relay between the browser's socket and Slack's, with the session added. */
const socketHandlers = {
  close(socket: ServerWebSocket<SlackWebSocketData>): void {
    socket.data.upstream?.close();
  },
  message(
    socket: ServerWebSocket<SlackWebSocketData>,
    raw: string | Buffer
  ): void {
    const frame = typeof raw === 'string' ? raw : raw.toString();
    const upstream = socket.data.upstream;
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(withRealToken(frame));
    } else {
      socket.data.pending.push(frame);
    }
  },
  open(socket: ServerWebSocket<SlackWebSocketData>): void {
    // Bun's WebSocket takes request headers; the session rides only on this
    // leg, never through the browser.
    const upstream = new WebSocket(socket.data.upstreamUrl, {
      headers: {
        Cookie: sessionCookie() ?? '',
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

interface Certificate {
  cert: string;
  key: string;
  /** base64 SHA-256 of the public key, for `--ignore-certificate-errors-spki-list`. */
  spki: string;
}

let certificate: Promise<Certificate> | undefined;

/**
 * One throwaway key per process. The browser trusts exactly this key (by its
 * SPKI hash) — not a blanket certificate bypass — and only ever meets it on
 * loopback, where its resolver points `*.slack.com`.
 */
function ensureCertificate(): Promise<Certificate> {
  certificate ??= (async () => {
    const dir = await mkdtemp(nodePath.join(tmpdir(), 'kyto-slack-tls-'));
    try {
      const keyPath = nodePath.join(dir, 'key.pem');
      const certPath = nodePath.join(dir, 'cert.pem');
      await execFileAsync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '3650',
        '-subj',
        '/CN=kyto-slack-browser',
      ]);
      const [cert, key] = await Promise.all([
        readFile(certPath, 'utf8'),
        readFile(keyPath, 'utf8'),
      ]);
      const der = createPublicKey(cert).export({ format: 'der', type: 'spki' });
      const spki = createHash('sha256').update(der).digest('base64');
      return { cert, key, spki };
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  })();
  certificate.catch(() => {
    certificate = undefined;
  });
  return certificate;
}

export interface SlackWebProxy {
  port: number;
  spki: string;
  stop: () => void;
}

/** Start one session's loopback listener; `stop` when the session ends. */
export async function startSlackWebProxy(): Promise<SlackWebProxy> {
  const { cert, key, spki } = await ensureCertificate();
  const server = Bun.serve<SlackWebSocketData>({
    fetch: (request, bunServer) => forward({ request, server: bunServer }),
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert, key },
    websocket: socketHandlers,
  });
  if (!server.port) {
    server.stop(true);
    throw new Error('Slack browser proxy did not get a port');
  }
  return { port: server.port, spki, stop: () => server.stop(true) };
}
