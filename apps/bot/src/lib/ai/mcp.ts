import type { UserMcpServer } from '@repo/db/queries';
import type { Logger } from '@repo/logging/logger';
import { jsonSchema, type Tool, tool } from 'ai';
import { z } from 'zod';
import type { McpServerForTurn } from '@/lib/ai/mcp-scope';
import { emailRedactor, redactionNote } from '@/lib/email/redact';
import { assertPublicHost } from '@/lib/public-url';
import {
  classifyMcpTool,
  type McpCategory,
  type McpRule,
  parseMcpRules,
  resolveMcpRule,
} from './mcp-permissions';

// The built-in AgentMail server (lib/ai/mcp-builtin): its results go through
// the email redaction below. Here, not there, so tests of this module need no
// environment.
export const AGENTMAIL_BUILTIN_ID = 'builtin:agentmail';

// Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0 via
// POST), hand-rolled on purpose: it has zero dependencies and only needs
// initialize / tools/list / tools/call. A Streamable-HTTP initialize that is
// refused (404/405) or answered with non-JSON is taken to be a legacy SSE-only
// server, and the same calls are then retried over the 2024-11-05 HTTP+SSE
// transport: one GET stream that hands over a POST endpoint, with replies
// arriving as `message` events on that same stream. Slack gives the bot no
// channel to a user's local machine anyway, so only remote HTTP(S) servers can
// ever work here.

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 60_000;
// Cached tool listings so turns don't pay a discovery round-trip per turn.
const LIST_CACHE_TTL_MS = 10 * 60 * 1000;
// A server that just failed is skipped for this long. Listing a broken server
// costs up to two 8s timeouts, and `buildMcpTools` is awaited while the toolset
// is assembled — so one dead entry used to add that to EVERY turn of that
// user's, forever, silently.
const FAILURE_TTL_MS = 60 * 1000;
// A rejected credential stays rejected until someone edits the entry, which
// clears the failure (`forgetMcpFailure`) — retrying it every minute only
// added its round trip to the owner's turns.
const AUTH_FAILURE_TTL_MS = 30 * 60 * 1000;
const AUTH_FAILURE = /\b(401|403)\b/;
// An auth-scheme token followed by a credential (RFC 7235), e.g. `Bearer x`.
const HAS_AUTH_SCHEME = /^[A-Za-z][\w-]*\s+\S/;
const MAX_FAILURE_MESSAGE = 200;

// Providers reject a tool name past 64 characters.
const MAX_TOOL_NAME_LENGTH = 64;
const objectSchema = z.looseObject({ type: z.literal('object') });

const toolListSchema = z.object({
  tools: z.array(
    z.looseObject({
      // The MCP spec's behaviour hints (readOnlyHint / destructiveHint). Kept
      // because they are the best classification signal there is — even though
      // the server that prompted all this sends `{}` for every tool.
      annotations: z.record(z.string(), z.unknown()).optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      name: z.string(),
    })
  ),
});

const callResultSchema = z.looseObject({
  content: z
    .array(
      z.looseObject({
        text: z.string().optional(),
        type: z.string(),
      })
    )
    .optional(),
  isError: z.boolean().optional(),
});

interface McpToolInfo {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

const listCache = new Map<string, { at: number; tools: McpToolInfo[] }>();

export interface McpFailure {
  at: number;
  message: string;
}

// Why a user's server produced no tools, so App Home can say so. In memory on
// purpose: it is a fact about the last attempt, not about the entry, and a
// restart should re-derive it rather than show a stale complaint.
const failures = new Map<string, McpFailure>();

// Keyed by the server ROW, not by (user, name). A shared server is one row seen
// by several people, and a failure on it is a fact about that row — keying it by
// whoever's turn hit it would record the same outage once per user and show the
// sharer nothing.
function failureKey(serverId: string): string {
  return serverId;
}

/**
 * Turn what a person actually pastes into a usable `Authorization` header.
 *
 * The App Home field asks for a header *value*, but a bare API token is what
 * every provider hands you and so what gets pasted. A token with no scheme
 * makes a bearer-auth server answer 401, which this module then swallowed into
 * silence — a Coolify entry with a perfectly valid token sat dead for a day for
 * exactly this. A value that already names a scheme is left alone, so `Basic …`
 * and custom schemes still work.
 */
export function normalizeMcpAuthorization(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  return HAS_AUTH_SCHEME.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/** The last failure for one of a user's servers, for the App Home tab. */
export function getMcpFailure(serverId: string): McpFailure | undefined {
  return failures.get(failureKey(serverId));
}

/** Called when an entry is saved or removed: the old verdict no longer applies. */
export function forgetMcpFailure(serverId: string): void {
  failures.delete(failureKey(serverId));
}

// A Streamable-HTTP probe that failed in the shape of an SSE-only server: the
// POST is refused (404/405) or answered with something that is not JSON. Only
// initialization acts on it — the SAME failure on a later call is a genuine
// error, not a signal to switch transports. Not exported: transport is decided
// here, not by a caller.
class LegacySseFallbackError extends Error {}

interface PendingSseRequest {
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
}

class McpConnection {
  private readonly server: UserMcpServer;
  private sessionId: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;
  private transport: 'http' | 'sse' = 'http';
  private sseEndpoint: string | undefined;
  private sseController: AbortController | undefined;
  private ssePump: Promise<void> | undefined;
  private sseReady: Promise<void> | undefined;
  private resolveSseEndpoint: (() => void) | undefined;
  private rejectSseEndpoint: ((error: unknown) => void) | undefined;
  private readonly ssePending = new Map<number, PendingSseRequest>();

  constructor({ server }: { server: UserMcpServer }) {
    this.server = server;
  }

  private rpc(
    method: string,
    params: unknown,
    {
      abortSignal,
      notification = false,
      timeoutMs = CALL_TIMEOUT_MS,
    }: {
      abortSignal?: AbortSignal;
      notification?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<unknown> {
    if (this.transport === 'sse') {
      return this.rpcOverSse(method, params, {
        abortSignal,
        notification,
        timeoutMs,
      });
    }
    return this.rpcOverHttp(method, params, {
      abortSignal,
      notification,
      timeoutMs,
    });
  }

  private async rpcOverHttp(
    method: string,
    params: unknown,
    {
      abortSignal,
      notification = false,
      timeoutMs = CALL_TIMEOUT_MS,
    }: {
      abortSignal?: AbortSignal;
      notification?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    // Re-checked at CONNECT time, not only when the entry was saved: a hostname
    // that resolved to a public address yesterday can resolve to 127.0.0.1
    // today, and this fetch runs from inside kyto's own network with the
    // response printed back into a Slack thread. Redirects are never followed
    // (a 3xx fails as !ok): a public server could 307 to an internal one, and
    // the hop would carry this server's credential with it.
    await assertPublicHost(this.server.url);
    const response = await fetch(this.server.url, {
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notification ? {} : { id }),
      }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(this.server.authorization
          ? { authorization: this.server.authorization }
          : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      method: 'POST',
      redirect: 'manual',
      // The turn's own signal too: a stopped turn kept the call running for up
      // to the full minute.
      signal: abortSignal
        ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) {
      this.sessionId = session;
    }
    if (!response.ok) {
      // 404/405 is the shape of an SSE-only server with no POST endpoint at its
      // root; mark it so initialization can retry over the legacy transport.
      if (response.status === 404 || response.status === 405) {
        await response.body?.cancel().catch(() => undefined);
        throw new LegacySseFallbackError(
          `MCP server responded ${response.status} for ${method}.`
        );
      }
      throw new Error(`MCP server responded ${response.status} for ${method}.`);
    }
    if (notification) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;
    if (contentType.includes('text/event-stream')) {
      payload = await readSseResponse(response, id as number);
    } else if (contentType && !contentType.includes('json')) {
      // An HTML error page (or similar) is not a JSON-RPC reply — the shape of
      // an SSE-only server answering a POST it does not implement.
      await response.body?.cancel().catch(() => undefined);
      throw new LegacySseFallbackError(
        `MCP server replied to ${method} with ${contentType}, which is not JSON.`
      );
    } else {
      try {
        payload = await response.json();
      } catch {
        throw new LegacySseFallbackError(
          `MCP server's reply to ${method} was not valid JSON.`
        );
      }
    }
    const message = payload as {
      error?: { code?: number; message?: string };
      result?: unknown;
    };
    if (message.error) {
      throw new Error(
        `MCP ${method} failed: ${message.error.message ?? 'unknown error'}`
      );
    }
    return message.result;
  }

  private ensureInitialized(): Promise<void> {
    this.initialized ??= (async () => {
      if (this.transport === 'sse') {
        // A dropped stream ended the old session; open a fresh one.
        await this.connectLegacySse();
        await this.initialize();
        return;
      }
      try {
        await this.initialize();
      } catch (error) {
        // Only initialization falls back, and only from the Streamable-HTTP
        // attempt: a later call failing this way is a real error, and there is
        // no second legacy path to try.
        if (
          !(error instanceof LegacySseFallbackError) ||
          this.transport !== 'http'
        ) {
          throw error;
        }
        await this.connectLegacySse();
        await this.initialize();
      }
    })().catch((error: unknown) => {
      // Not cached: one transient failure used to fail every later call on
      // this connection for the rest of the turn.
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    await this.rpc(
      'initialize',
      {
        capabilities: {},
        clientInfo: { name: 'kyto', version: '1.0.0' },
        protocolVersion: PROTOCOL_VERSION,
      },
      { timeoutMs: CONNECT_TIMEOUT_MS }
    );
    await this.rpc('notifications/initialized', {}, { notification: true });
  }

  private connectLegacySse(): Promise<void> {
    this.sseReady ??= this.openLegacySse().catch((error: unknown) => {
      // Not cached, like a failed initialize: one dropped stream must not
      // condemn the server for the rest of the connection.
      this.sseReady = undefined;
      throw error;
    });
    return this.sseReady;
  }

  /**
   * Open the legacy transport: one long-lived GET stream whose first
   * `endpoint` event names where JSON-RPC POSTs go. The stream must stay open
   * for the session's life — every reply arrives on it as a `message` event.
   */
  private async openLegacySse(): Promise<void> {
    // The stream URL is user-supplied and fetched from kyto's own network, so
    // it gets the same public-host check as the Streamable-HTTP path.
    await assertPublicHost(this.server.url);
    const controller = new AbortController();
    this.sseController = controller;
    // A manual deadline for the GET's *headers* only, cleared once they arrive.
    // `AbortSignal.timeout` cannot be used here: it stays attached to the
    // response and would abort this long-lived body when it fired, killing the
    // session mid-turn. The endpoint wait below has its own deadline.
    const headerTimeout = setTimeout(() => {
      controller.abort(new Error('MCP SSE stream headers timed out.'));
    }, CONNECT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.server.url, {
        headers: {
          accept: 'text/event-stream',
          ...(this.server.authorization
            ? { authorization: this.server.authorization }
            : {}),
        },
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(headerTimeout);
    }
    if (!response.ok) {
      throw new Error(
        `MCP server responded ${response.status} for the SSE stream.`
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = response.body;
    if (!(contentType.includes('text/event-stream') && body)) {
      await body?.cancel().catch(() => undefined);
      throw new Error('MCP server did not open an event stream.');
    }
    const endpointReady = new Promise<void>((resolve, reject) => {
      this.resolveSseEndpoint = resolve;
      this.rejectSseEndpoint = reject;
    });
    this.ssePump = this.pumpLegacySse(body);
    const timer = setTimeout(() => {
      this.failSse(
        new Error('MCP server did not send its SSE endpoint in time.')
      );
    }, CONNECT_TIMEOUT_MS);
    try {
      await endpointReady;
    } finally {
      clearTimeout(timer);
    }
    this.transport = 'sse';
  }

  private async pumpLegacySse(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const event of sseEvents(body)) {
        if (event.event === 'endpoint') {
          await this.acceptSseEndpoint(event.data);
          continue;
        }
        if (event.event === 'message') {
          this.dispatchSseMessage(event.data);
        }
      }
    } catch (error) {
      this.failSse(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.failSse(new Error('MCP SSE stream ended.'));
  }

  private async acceptSseEndpoint(data: string): Promise<void> {
    let endpoint: string;
    try {
      // The server usually sends a relative path (`/messages?sessionId=…`); it
      // resolves against the stream's own URL, per the 2024-11-05 transport.
      endpoint = new URL(data, this.server.url).toString();
    } catch {
      this.failSse(new Error('MCP server sent an unparseable SSE endpoint.'));
      return;
    }
    if (new URL(endpoint).origin !== new URL(this.server.url).origin) {
      // The credential goes to this endpoint: never let the stream redirect it
      // to another host.
      this.failSse(
        new Error('MCP server sent an SSE endpoint on a different origin.')
      );
      return;
    }
    try {
      // The endpoint is fetched with the credential, so it is checked too.
      await assertPublicHost(endpoint);
    } catch (error) {
      this.failSse(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.sseEndpoint = endpoint;
    this.resolveSseEndpoint?.();
    this.resolveSseEndpoint = undefined;
    this.rejectSseEndpoint = undefined;
  }

  private dispatchSseMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // a keepalive or other non-JSON event, not a JSON-RPC reply
    }
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
      return; // server-initiated notification; kyto has no request to match it
    }
    const message = parsed as {
      error?: { code?: number; message?: string };
      id: number;
      result?: unknown;
    };
    const pending = this.ssePending.get(message.id);
    if (!pending) {
      return;
    }
    if (message.error) {
      pending.reject(
        new Error(
          `MCP call failed: ${message.error.message ?? 'unknown error'}`
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  private failSse(error: Error): void {
    this.rejectSseEndpoint?.(error);
    this.resolveSseEndpoint = undefined;
    this.rejectSseEndpoint = undefined;
    for (const pending of this.ssePending.values()) {
      pending.reject(error);
    }
    this.ssePending.clear();
    // The session is gone; dropping the endpoint makes a later call fail at
    // once instead of POSTing into a dead stream and waiting out its timeout,
    // and forgetting the handshake makes the next call open a new session
    // instead of failing for the rest of the turn.
    this.sseEndpoint = undefined;
    this.sseReady = undefined;
    if (this.transport === 'sse') {
      this.initialized = undefined;
    }
    this.sseController?.abort(error);
  }

  private async rpcOverSse(
    method: string,
    params: unknown,
    {
      abortSignal,
      notification = false,
      timeoutMs = CALL_TIMEOUT_MS,
    }: {
      abortSignal?: AbortSignal;
      notification?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<unknown> {
    const endpoint = this.sseEndpoint;
    if (!endpoint) {
      throw new Error('MCP SSE session has no message endpoint.');
    }
    const id = notification ? undefined : this.nextId++;
    await assertPublicHost(endpoint);
    // Register the reply slot BEFORE the POST. A legacy server acks with 202 and
    // pushes the reply as a `message` event on the GET stream, and that event can
    // beat the POST's response back to the client — a slot registered afterwards
    // would miss the only copy of the reply and hang to its timeout.
    const reply = notification
      ? undefined
      : this.awaitSseReply(id as number, { abortSignal, method, timeoutMs });
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params,
          ...(notification ? {} : { id }),
        }),
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(this.server.authorization
            ? { authorization: this.server.authorization }
            : {}),
          'mcp-protocol-version': PROTOCOL_VERSION,
        },
        method: 'POST',
        redirect: 'manual',
        signal: abortSignal
          ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const error = new Error(
          `MCP server responded ${response.status} for ${method}.`
        );
        this.ssePending.get(id as number)?.reject(error);
        await reply?.catch(() => undefined);
        throw error;
      }
      // A legacy server acks a POST with 202 and no body; the reply, if any,
      // had better already be registered above — it comes as a `message` event.
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      // The POST went nowhere: settle the reply slot too, so the awaited promise
      // neither leaks a pending entry nor trips an unhandled rejection.
      this.ssePending.get(id as number)?.reject(error);
      await reply?.catch(() => undefined);
      throw error;
    }
    if (notification) {
      return;
    }
    return reply;
  }

  private awaitSseReply(
    id: number,
    {
      abortSignal,
      method,
      timeoutMs,
    }: { abortSignal?: AbortSignal; method: string; timeoutMs: number }
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const finish = (error: unknown, value?: unknown) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
        this.ssePending.delete(id);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const onAbort = () =>
        finish(abortSignal?.reason ?? new Error('MCP call aborted.'));
      const timer = setTimeout(
        () => finish(new Error(`MCP ${method} timed out.`)),
        timeoutMs
      );
      if (abortSignal?.aborted) {
        finish(abortSignal.reason ?? new Error('MCP call aborted.'));
        return;
      }
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.ssePending.set(id, {
        reject: (error) => finish(error),
        resolve: (value) => finish(undefined, value),
      });
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    // Keyed by credential as well as URL: two users may register the same
    // server with different tokens, and a token often decides which tools come
    // back. Keying on the URL alone served one user's listing to another.
    const cacheKey = `${this.server.url}\n${this.server.authorization ?? ''}`;
    const cached = listCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
      return cached.tools;
    }
    await this.ensureInitialized();
    const result = toolListSchema.parse(
      await this.rpc('tools/list', {}, { timeoutMs: CONNECT_TIMEOUT_MS })
    );
    const tools = result.tools.map((entry) => ({
      annotations: entry.annotations as Record<string, unknown> | undefined,
      description: entry.description,
      inputSchema: entry.inputSchema as Record<string, unknown> | undefined,
      name: entry.name,
    }));
    listCache.set(cacheKey, { at: Date.now(), tools });
    return tools;
  }

  async callTool({
    abortSignal,
    args,
    name,
  }: {
    abortSignal?: AbortSignal;
    args: unknown;
    name: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const result = callResultSchema.parse(
      await this.rpc(
        'tools/call',
        { arguments: args ?? {}, name },
        { abortSignal }
      )
    );
    const text = (result.content ?? [])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
    if (result.isError) {
      throw new Error(text || 'MCP tool call failed.');
    }
    return text || JSON.stringify(result);
  }

  async close(): Promise<void> {
    // Legacy SSE has no session to DELETE — the long-lived GET stream IS the
    // session, so closing it means aborting the stream, letting the pump settle
    // (which cancels the reader), and failing anything still waiting on a reply.
    this.resolveSseEndpoint = undefined;
    this.rejectSseEndpoint = undefined;
    for (const pending of this.ssePending.values()) {
      pending.reject(new Error('MCP connection closed.'));
    }
    this.ssePending.clear();
    this.sseController?.abort();
    await this.ssePump?.catch(() => undefined);
    if (!this.sessionId) {
      return;
    }
    const isPublic = await assertPublicHost(this.server.url).then(
      () => true,
      () => false
    );
    if (!isPublic) {
      return;
    }
    await fetch(this.server.url, {
      headers: {
        ...(this.server.authorization
          ? { authorization: this.server.authorization }
          : {}),
        'mcp-session-id': this.sessionId,
      },
      method: 'DELETE',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }
}

interface SseEvent {
  data: string;
  /** The `event:` field; `message` when the server omits it, per the SSE spec. */
  event: string;
}

function parseSseEvent(block: string): SseEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    }
  }
  return data.length > 0 ? { data: data.join('\n'), event } : undefined;
}

/**
 * Parse `text/event-stream` frames out of a fetch body. Shared by the
 * Streamable-HTTP reply reader (one POST, one reply, then the stream ends) and
 * the legacy transport (one long-lived GET stream carrying many replies).
 */
async function* sseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      // SSE allows CRLF line endings; normalized so `\n\n` finds every event.
      buffer += decoder
        .decode(value, { stream: true })
        .replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(block);
        if (event) {
          yield event;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readSseResponse(
  response: Response,
  id: number
): Promise<unknown> {
  const body = response.body;
  if (!body) {
    throw new Error('MCP SSE response had no body.');
  }
  for await (const event of sseEvents(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue; // a keepalive or other non-JSON event, not our reply
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      parsed.id === id
    ) {
      return parsed;
    }
  }
  throw new Error('MCP SSE response ended without a matching reply.');
}

export interface McpToolGate {
  category: McpCategory;
  /** The Slack user whose credential this server runs on. */
  ownerUserId: string;
  rule: McpRule;
  /** The server's handle, as registered in App Home. */
  server: string;
  /** The `user_mcp_servers` row, so a standing rule edits the right one. */
  serverId: string;
  /**
   * Set when this server is only in scope because someone shared it into the
   * channel. Whoever's turn it is decides an `ask` (the owner's call — "person b
   * can also approve it"), but a STANDING rule stays with the person whose
   * credential it is, so the prompt hides those buttons.
   */
  sharedBy?: string;
  /** The server's own name for the tool, un-namespaced. */
  tool: string;
}

/**
 * Ask the person whose server this is whether one call may go ahead. Supplied by
 * the Slack layer (`lib/mcp-permissions`); absent for callers with nobody to ask
 * (reminders, the subagent), where an `ask` tool therefore refuses.
 */
export type McpPermissionRequest = (
  input: McpToolGate & { abortSignal?: AbortSignal; args: unknown }
) => Promise<{ allowed: boolean; detail: string }>;

export interface BuiltMcpTools {
  /** Tools a server advertised that the user's rules keep hidden from the model. */
  blocked: { categories: McpCategory[]; count: number; server: string }[];
  close: () => Promise<void>;
  /** By namespaced tool name, so the caller can describe what it exposed. */
  gates: Record<string, McpToolGate>;
  /**
   * The person's own and shared servers (not the built-ins), each with how
   * many tools it exposed or why it failed this turn, sorted by namespace.
   */
  status: { failure?: string; server: string; tools: number }[];
  tools: Record<string, Tool>;
}

/**
 * Build namespaced ai tools for one user's MCP servers. Listing uses the
 * shared schema cache (one discovery round-trip per server per 10 minutes);
 * calls open a per-turn connection lazily. Returns the tools plus a `close`
 * to run at turn end. A dead server degrades that turn's toolset, not the bot.
 *
 * Every advertised tool is sorted into a category and checked against the
 * server's rules: `allow` registers it as-is, `ask` wraps it so the call waits on
 * a click, and `never` is NOT REGISTERED AT ALL — a hidden tool cannot be reached
 * by a prompt injection, and its schema does not ride along in the prompt either.
 * The count is reported back so the model can say the category is off rather than
 * inventing a reason the tool is missing.
 */
export async function buildMcpTools({
  logger,
  redactEmail,
  requestPermission,
  servers,
}: {
  logger: Logger;
  /** False only on an owner's `--no-redact` turn (lib/email/redact). */
  redactEmail: boolean;
  requestPermission?: McpPermissionRequest;
  servers: McpServerForTurn[];
}): Promise<BuiltMcpTools> {
  const redactEmailSecrets = emailRedactor(redactEmail);
  const connections: McpConnection[] = [];
  const tools: Record<string, Tool> = {};
  const gates: Record<string, McpToolGate> = {};
  const blocked: BuiltMcpTools['blocked'] = [];
  const status: BuiltMcpTools['status'] = [];
  await Promise.all(
    servers.map(async ({ namespace, server, sharedBy }) => {
      const builtin = server.id.startsWith('builtin:');
      const key = failureKey(server.id);
      const recent = failures.get(key);
      const ttl =
        recent && AUTH_FAILURE.test(recent.message)
          ? AUTH_FAILURE_TTL_MS
          : FAILURE_TTL_MS;
      if (recent && Date.now() - recent.at < ttl) {
        if (!builtin) {
          status.push({ failure: recent.message, server: namespace, tools: 0 });
        }
        return;
      }
      const connection = new McpConnection({ server });
      const rules = parseMcpRules(server.rules);
      const hidden = new Set<McpCategory>();
      let hiddenCount = 0;
      let registered = 0;
      try {
        const infos = await connection.listTools();
        connections.push(connection);
        failures.delete(key);
        for (const info of infos) {
          const category = classifyMcpTool(info);
          const rule = resolveMcpRule({ category, rules, tool: info.name });
          if (rule === 'never') {
            hidden.add(category);
            hiddenCount += 1;
            continue;
          }
          const toolName = `mcp_${namespace}_${info.name}`.replaceAll(
            /[^\w-]/g,
            '_'
          );
          // A server's tool list is untrusted input, and loaded tools are
          // remembered per thread: one name past the providers' 64-char limit
          // failed every request of every later turn in that thread. Sanitizing
          // can also fold two names together (`a.b`, `a_b`); first one wins.
          if (toolName.length > MAX_TOOL_NAME_LENGTH || tools[toolName]) {
            logger.warn(
              { server: namespace, tool: info.name },
              '[mcp] tool skipped: name too long or colliding'
            );
            continue;
          }
          registered += 1;
          gates[toolName] = {
            category,
            ownerUserId: server.userId,
            rule,
            server: namespace,
            serverId: server.id,
            ...(sharedBy ? { sharedBy } : {}),
            tool: info.name,
          };
          tools[toolName] = tool({
            description:
              info.description ??
              `Tool ${info.name} on the ${namespace} MCP server.`,
            inputSchema: jsonSchema(
              objectSchema.safeParse(info.inputSchema).data ?? {
                properties: {},
                type: 'object',
              }
            ),
            execute: async (
              args: unknown,
              options?: { abortSignal?: AbortSignal }
            ) => {
              if (rule === 'ask') {
                if (!requestPermission) {
                  return `Not run. ${info.name} on the ${namespace} MCP server is set to ask permission first, and this turn has nobody to ask (it is running unattended). Tell the user to change the rule in App Home if they want it to run here.`;
                }
                const decision = await requestPermission({
                  abortSignal: options?.abortSignal,
                  args,
                  category,
                  ownerUserId: server.userId,
                  rule,
                  server: namespace,
                  serverId: server.id,
                  ...(sharedBy ? { sharedBy } : {}),
                  tool: info.name,
                });
                if (!decision.allowed) {
                  return decision.detail;
                }
              }
              const text = await connection.callTool({
                abortSignal: options?.abortSignal,
                args,
                name: info.name,
              });
              if (server.id !== AGENTMAIL_BUILTIN_ID) {
                return text;
              }
              const clean = redactEmailSecrets(text);
              const note = redactionNote(clean.redactions);
              return note ? `${clean.text}\n\n${note}` : clean.text;
            },
          });
        }
        if (!builtin) {
          status.push({ server: namespace, tools: registered });
        }
        if (hiddenCount > 0) {
          blocked.push({
            categories: [...hidden].sort(),
            count: hiddenCount,
            server: namespace,
          });
          logger.info(
            {
              categories: [...hidden],
              hidden: hiddenCount,
              server: namespace,
              userId: server.userId,
            },
            '[mcp] tools hidden by the user’s rules'
          );
        }
      } catch (error) {
        // A legacy SSE server may have opened its long-lived stream before the
        // listing failed; this connection is never handed back, so nothing else
        // would ever close it.
        await connection.close();
        // Recorded, not just logged: a dropped server produces zero tools and
        // used to produce zero feedback too, so a bad entry was indistinguishable
        // from a server with nothing to offer. App Home reads this back.
        const message = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, MAX_FAILURE_MESSAGE);
        failures.set(key, { at: Date.now(), message });
        if (!builtin) {
          status.push({ failure: message, server: namespace, tools: 0 });
        }
        logger.warn(
          { err: error, server: namespace, url: server.url },
          '[mcp] server unavailable this turn'
        );
      }
    })
  );
  return {
    blocked,
    close: async () => {
      await Promise.all(connections.map((connection) => connection.close()));
    },
    gates,
    status: status.sort((a, b) => a.server.localeCompare(b.server)),
    tools,
  };
}
