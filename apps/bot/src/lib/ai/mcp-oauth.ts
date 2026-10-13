// OAuth sign-in for a person's own MCP servers (owner's ask 2026-10-13), per
// the MCP authorization spec: the server names its authorization server
// (protected-resource metadata, RFC 9728), kyto registers itself there as a
// public client (dynamic client registration, RFC 7591), and the person signs in
// with PKCE. Tokens are refreshed before each turn that needs them.
//
// Every URL here comes from a server the person typed or from metadata that
// server returned, so every request goes through `publicFetch`: a metadata
// document pointing its token endpoint at 169.254.169.254 must not make kyto
// fetch it.
//
// The client registration and the tokens live in ONE encrypted column
// (`user_mcp_servers.oauth`), only when BYOK_ENCRYPTION_KEY is set. The pending
// sign-in rides in the encrypted `state`, as in lib/slack-oauth: there is no
// public start route, the link is shown only to the server's owner.

import { createHash, randomBytes } from 'node:crypto';
import {
  getMcpServerById,
  setMcpServerOauth,
  type UserMcpServer,
} from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import {
  byokConfigured,
  decryptSecret,
  encryptSecret,
} from '@/lib/byok/crypto';
import { escapeHtml } from '@/lib/dashboard/render';
import logger from '@/lib/logger';
import { publicFetch } from '@/lib/public-url';
import { registerSecret } from '@/lib/redact';

const CALLBACK_PATH = '/_mcpauth/callback';
const STATE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// Refresh this long before the access token runs out, so it doesn't expire in
// the middle of the turn that is about to use it.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MCP_PROTOCOL_VERSION = '2025-06-18';

const resourceMetadataSchema = z.looseObject({
  authorization_servers: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
});
const serverMetadataSchema = z.looseObject({
  authorization_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  token_endpoint: z.string(),
});
const registrationSchema = z.looseObject({
  client_id: z.string(),
  client_secret: z.string().optional(),
});
const tokenSchema = z.looseObject({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});
const stateSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string().optional(),
  expiry: z.number(),
  resource: z.string(),
  serverId: z.string(),
  tokenEndpoint: z.string(),
  userId: z.string(),
  verifier: z.string(),
});
const storedSchema = z.object({
  accessToken: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  expiresAt: z.number().optional(),
  refreshToken: z.string().optional(),
  resource: z.string(),
  tokenEndpoint: z.string(),
});
type StoredOauth = z.infer<typeof storedSchema>;

export function mcpOauthConfigured(): boolean {
  return byokConfigured();
}

function redirectUri(): string {
  return `https://${env.SITES_PUBLIC_HOST}${CALLBACK_PATH}`;
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await publicFetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} answered ${response.status}`);
  }
  return await response.json();
}

async function tryJson(url: string): Promise<unknown> {
  return await getJson(url, { headers: { accept: 'application/json' } }).catch(
    () => undefined
  );
}

// The 401 a compliant server answers an unauthenticated request with names its
// metadata document; failing that, the well-known locations.
async function resourceMetadata(serverUrl: string) {
  const server = new URL(serverUrl);
  const candidates: string[] = [];
  const probe = await publicFetch(serverUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'kyto', version: '1' },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
  const named = /resource_metadata="([^"]+)"/.exec(
    probe?.headers.get('www-authenticate') ?? ''
  )?.[1];
  if (named) {
    candidates.push(new URL(named, server).toString());
  }
  const path = server.pathname === '/' ? '' : server.pathname;
  candidates.push(
    `${server.origin}/.well-known/oauth-protected-resource${path}`,
    `${server.origin}/.well-known/oauth-protected-resource`
  );
  for (const candidate of candidates) {
    const parsed = resourceMetadataSchema.safeParse(await tryJson(candidate));
    if (parsed.success && parsed.data.authorization_servers?.length) {
      return parsed.data;
    }
  }
  // An older server (spec 2025-03-26) is its own authorization server.
  return {
    authorization_servers: [server.origin],
    scopes_supported: undefined,
  };
}

async function serverMetadata(issuer: string) {
  const url = new URL(issuer);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    const parsed = serverMetadataSchema.safeParse(await tryJson(candidate));
    if (parsed.success) {
      return parsed.data;
    }
  }
  return;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * The link the server's owner opens to sign in, or why there can't be one.
 * Registers kyto as a client on the way (a fresh registration per sign-in:
 * nothing to clean up if it is never used, and no client id to keep in sync).
 */
export async function startMcpOauth({
  server,
  userId,
}: {
  server: UserMcpServer;
  userId: string;
}): Promise<{ error: string } | { url: string }> {
  if (!mcpOauthConfigured()) {
    return {
      error: 'kyto is not set up to store sign-ins (no encryption key).',
    };
  }
  if (server.userId !== userId) {
    return {
      error: 'Only the person who added this server can sign in to it.',
    };
  }
  try {
    const resource = await resourceMetadata(server.url);
    const issuer = resource.authorization_servers?.[0];
    const metadata = issuer ? await serverMetadata(issuer) : undefined;
    if (!metadata) {
      return {
        error:
          "This server doesn't publish an OAuth sign-in kyto can find. If it gives you an API token instead, paste that under Edit.",
      };
    }
    if (!metadata.registration_endpoint) {
      return {
        error:
          "This server's sign-in doesn't let new apps register themselves, so kyto can't sign in to it. If it gives you an API token, paste that under Edit.",
      };
    }
    const registration = registrationSchema.parse(
      await getJson(metadata.registration_endpoint, {
        body: JSON.stringify({
          client_name: 'kyto',
          grant_types: ['authorization_code', 'refresh_token'],
          redirect_uris: [redirectUri()],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    );
    const verifier = base64url(randomBytes(32));
    const state = encryptSecret(
      JSON.stringify({
        clientId: registration.client_id,
        clientSecret: registration.client_secret,
        expiry: Date.now() + STATE_TTL_MS,
        resource: server.url,
        serverId: server.id,
        tokenEndpoint: metadata.token_endpoint,
        userId,
        verifier,
      } satisfies z.infer<typeof stateSchema>)
    );
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', registration.client_id);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set(
      'code_challenge',
      base64url(createHash('sha256').update(verifier).digest())
    );
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', server.url);
    url.searchParams.set('state', state);
    if (resource.scopes_supported?.length) {
      url.searchParams.set('scope', resource.scopes_supported.join(' '));
    }
    return { url: url.toString() };
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        serverId: server.id,
      },
      '[mcp-oauth] could not start a sign-in'
    );
    return {
      error: `kyto couldn't start a sign-in with this server (${error instanceof Error ? error.message : 'unknown error'}).`,
    };
  }
}

async function requestToken({
  clientId,
  clientSecret,
  params,
  resource,
  tokenEndpoint,
}: {
  clientId: string;
  clientSecret?: string;
  params: Record<string, string>;
  resource: string;
  tokenEndpoint: string;
}): Promise<z.infer<typeof tokenSchema>> {
  const body = new URLSearchParams({
    ...params,
    client_id: clientId,
    resource,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  return tokenSchema.parse(
    await getJson(tokenEndpoint, {
      body,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })
  );
}

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">${title}</h1><p>${body}</p></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status }
  );
}

function decodeState(raw: string | null) {
  if (!raw) {
    return;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(decryptSecret(raw)));
    return parsed.success && parsed.data.expiry > Date.now()
      ? parsed.data
      : undefined;
  } catch {
    return;
  }
}

/** The sign-in callback, or null when the path isn't ours. */
export async function handleMcpOauth(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (pathname !== CALLBACK_PATH) {
    return null;
  }
  if (!mcpOauthConfigured()) {
    return page('Not available', 'kyto is not configured for this.', 404);
  }
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) {
    return page('Cancelled', `The server said: ${escapeHtml(error)}.`, 400);
  }
  const state = decodeState(url.searchParams.get('state'));
  const code = url.searchParams.get('code');
  if (!(state && code)) {
    return page(
      'Link expired',
      'That sign-in link is no longer valid. Start again from kyto’s App Home.',
      400
    );
  }
  // The server must still be this person's, at the same address, or the
  // tokens would land on something they no longer meant.
  const server = await getMcpServerById(state.serverId).catch(() => undefined);
  if (
    !(server && server.userId === state.userId && server.url === state.resource)
  ) {
    return page(
      'Server changed',
      'That MCP server was removed or changed since you started. Sign in again from kyto’s App Home.',
      400
    );
  }
  try {
    const token = await requestToken({
      clientId: state.clientId,
      clientSecret: state.clientSecret,
      params: {
        code,
        code_verifier: state.verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(),
      },
      resource: state.resource,
      tokenEndpoint: state.tokenEndpoint,
    });
    await saveOauth({
      id: server.id,
      stored: {
        accessToken: token.access_token,
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        expiresAt: token.expires_in
          ? Date.now() + token.expires_in * 1000
          : undefined,
        refreshToken: token.refresh_token,
        resource: state.resource,
        tokenEndpoint: state.tokenEndpoint,
      },
    });
    logger.info(
      { serverId: server.id, userId: server.userId },
      '[mcp-oauth] signed in'
    );
    return page(
      'Signed in',
      `kyto can now use <code>${escapeHtml(server.name)}</code> as you. You can close this tab and go back to Slack. Sign out any time from kyto’s App Home.`,
      200
    );
  } catch (caught) {
    logger.warn(
      {
        err: caught instanceof Error ? caught.message : String(caught),
        serverId: server.id,
      },
      '[mcp-oauth] code exchange failed'
    );
    return page(
      'Something went wrong',
      'The server would not complete the sign-in. Try again from kyto’s App Home.',
      502
    );
  }
}

async function saveOauth({
  id,
  stored,
}: {
  id: string;
  stored: StoredOauth;
}): Promise<void> {
  await setMcpServerOauth({ id, oauth: encryptSecret(JSON.stringify(stored)) });
}

function readStored(server: UserMcpServer): StoredOauth | undefined {
  if (!(server.oauth && mcpOauthConfigured())) {
    return;
  }
  try {
    const parsed = storedSchema.safeParse(
      JSON.parse(decryptSecret(server.oauth))
    );
    // Signed in for a different address: the server was edited since.
    return parsed.success && parsed.data.resource === server.url
      ? parsed.data
      : undefined;
  } catch {
    return;
  }
}

/** Whether the server has a usable OAuth sign-in (for App Home). */
export function hasMcpOauth(server: UserMcpServer): boolean {
  return readStored(server) !== undefined;
}

// One refresh per server at a time: a rotating refresh token used twice gets
// the second caller (and often the whole grant) refused.
const refreshing = new Map<string, Promise<string | undefined>>();

async function freshAccessToken(
  server: UserMcpServer
): Promise<string | undefined> {
  const stored = readStored(server);
  if (!stored) {
    return;
  }
  const expiring =
    stored.expiresAt !== undefined &&
    stored.expiresAt - REFRESH_MARGIN_MS < Date.now();
  if (!(expiring && stored.refreshToken)) {
    return stored.accessToken;
  }
  const refreshToken = stored.refreshToken;
  try {
    const token = await requestToken({
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      params: { grant_type: 'refresh_token', refresh_token: refreshToken },
      resource: stored.resource,
      tokenEndpoint: stored.tokenEndpoint,
    });
    await saveOauth({
      id: server.id,
      stored: {
        ...stored,
        accessToken: token.access_token,
        expiresAt: token.expires_in
          ? Date.now() + token.expires_in * 1000
          : undefined,
        refreshToken: token.refresh_token ?? refreshToken,
      },
    });
    return token.access_token;
  } catch (error) {
    // The old token is tried anyway; if it is dead, the listing fails with a
    // 401 and App Home shows it, which is the person's cue to sign in again.
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        serverId: server.id,
      },
      '[mcp-oauth] refresh failed'
    );
    return stored.accessToken;
  }
}

/**
 * The server with its OAuth access token as the Authorization header, fresh
 * enough for a turn — or the server unchanged when it has no sign-in.
 */
export async function withMcpOauth(
  server: UserMcpServer
): Promise<UserMcpServer> {
  if (!server.oauth) {
    return server;
  }
  let pending = refreshing.get(server.id);
  if (!pending) {
    pending = freshAccessToken(server).finally(() => {
      refreshing.delete(server.id);
    });
    refreshing.set(server.id, pending);
  }
  const token = await pending;
  if (!token) {
    return server;
  }
  registerSecret({ label: `MCP ${server.name} OAuth token`, value: token });
  return { ...server, authorization: `Bearer ${token}` };
}
