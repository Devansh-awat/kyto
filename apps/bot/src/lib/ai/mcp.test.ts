import { describe, expect, test } from 'bun:test';
import type { UserMcpServer } from '@repo/db/queries';
import { createLogger } from '@repo/logging/logger';
import { buildMcpTools, normalizeMcpAuthorization } from './mcp';

// The bug this exists to prevent: a Coolify entry saved with a valid API token
// pasted bare produced `Authorization: 3|…`, which the server answered 401,
// which `buildMcpTools` swallowed — no tools, no error, for a day.
describe('normalizeMcpAuthorization', () => {
  test('prefixes Bearer onto a bare token', () => {
    expect(normalizeMcpAuthorization('3|tokenvalue')).toBe(
      'Bearer 3|tokenvalue'
    );
  });

  test('leaves a value that already names a scheme alone', () => {
    expect(normalizeMcpAuthorization('Bearer abc')).toBe('Bearer abc');
    expect(normalizeMcpAuthorization('bearer abc')).toBe('bearer abc');
    expect(normalizeMcpAuthorization('Basic creds')).toBe('Basic creds');
    expect(normalizeMcpAuthorization('token ghp_x')).toBe('token ghp_x');
  });

  test('is idempotent', () => {
    const once = normalizeMcpAuthorization('ghp_x');
    expect(normalizeMcpAuthorization(once)).toBe('Bearer ghp_x');
  });

  test('trims, and treats blank as absent', () => {
    expect(normalizeMcpAuthorization('  ghp_x  ')).toBe('Bearer ghp_x');
    expect(normalizeMcpAuthorization('   ')).toBeUndefined();
    expect(normalizeMcpAuthorization('')).toBeUndefined();
    expect(normalizeMcpAuthorization(undefined)).toBeUndefined();
    expect(normalizeMcpAuthorization(null)).toBeUndefined();
  });

  test('does not mistake a token containing punctuation for a scheme', () => {
    // JWTs and `sk-`/`ghp_`-style keys have no space, so they are credentials,
    // not schemes — the space is what distinguishes the two.
    expect(normalizeMcpAuthorization('eyJhbGciOi.eyJzdWIi.abc')).toBe(
      'Bearer eyJhbGciOi.eyJzdWIi.abc'
    );
    expect(normalizeMcpAuthorization('sk-ant-api03-xyz')).toBe(
      'Bearer sk-ant-api03-xyz'
    );
  });
});

// A legacy SSE-only MCP server (the 2024-11-05 HTTP+SSE transport) refuses the
// Streamable-HTTP initialize (404) and answers JSON-RPC on one long-lived GET
// stream instead. This fixture is that server: the POST probe gets 404, the GET
// opens a stream, and every request POSTed to /messages is answered by a
// `message` event enqueued before the POST's own 202 returns — the reply can
// beat the POST response back to the client, which is exactly the shape that
// used to drop a reply and hang the call.
function legacySseFixture({
  endpoint = '/messages',
  url,
}: {
  endpoint?: string;
  url: string;
}) {
  const BASE = url;
  const replies: Record<string, unknown> = {
    initialize: {
      capabilities: {},
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'legacy', version: '0.0.0' },
    },
    'tools/list': {
      tools: [
        {
          annotations: { readOnlyHint: true },
          description: 'Tells you the weather.',
          inputSchema: { type: 'object' },
          name: 'get_weather',
        },
      ],
    },
    'tools/call': {
      content: [{ type: 'text', text: 'sunny' }],
    },
  };
  const calls: { method: string; path: string }[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    let raw: string;
    if (typeof input === 'string') {
      raw = input;
    } else if (input instanceof URL) {
      raw = input.href;
    } else {
      raw = input.url;
    }
    const url = new URL(raw);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    if (method === 'GET') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(
            new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`)
          );
          init?.signal?.addEventListener(
            'abort',
            () =>
              controller.error(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new Error('stream aborted')
              ),
            { once: true }
          );
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        })
      );
    }
    if (url.pathname === '/mcp') {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      id?: number;
      method: string;
    };
    if (request.id !== undefined) {
      stream?.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            id: request.id,
            jsonrpc: '2.0',
            result: replies[request.method],
          })}\n\n`
        )
      );
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  };
  return { BASE, calls, fetchMock };
}

const logger = await createLogger({ isProduction: true, logLevel: 'error' });

describe('legacy SSE fallback', () => {
  const server = (url: string): UserMcpServer => ({
    authorization: null,
    createdAt: new Date(),
    id: 'server-1',
    name: 'demo',
    oauth: null,
    rules: null,
    url,
    userId: 'user-1',
  });

  test('retries initialize over the SSE stream after the probe is refused', async () => {
    const fixture = legacySseFixture({ url: 'https://93.184.216.34/mcp' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fixture.fetchMock as typeof fetch;
    try {
      const built = await buildMcpTools({
        redactEmail: true,
        logger,
        servers: [{ namespace: 'demo', server: server(fixture.BASE) }],
      });
      try {
        const tool = built.tools.mcp_demo_get_weather;
        expect(tool).toBeDefined();
        if (!tool?.execute) {
          throw new Error('get_weather was not registered');
        }
        expect(
          await tool.execute(
            {},
            { context: undefined, messages: [], toolCallId: 'test-1' }
          )
        ).toBe('sunny');
      } finally {
        await built.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The probe went over plain HTTP (refused), the exchange over the stream.
    expect(fixture.calls[0]).toEqual({ method: 'POST', path: '/mcp' });
    expect(fixture.calls).toContainEqual({ method: 'GET', path: '/mcp' });
    expect(fixture.calls).toContainEqual({ method: 'POST', path: '/messages' });
  });

  test('records a failure for an SSE server whose stream never opens', async () => {
    // A fresh URL: the shared listing cache is keyed by URL and would otherwise
    // hand the first test's tools straight back without any fetch.
    const fixture = legacySseFixture({ url: 'https://93.184.216.35/mcp' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      if (init?.method === 'GET') {
        return Promise.resolve(
          new Response('<html>not sse</html>', {
            headers: { 'content-type': 'text/html' },
            status: 200,
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;
    try {
      const built = await buildMcpTools({
        redactEmail: true,
        logger,
        servers: [{ namespace: 'demo', server: server(fixture.BASE) }],
      });
      expect(built.tools.mcp_demo_get_weather).toBeUndefined();
      await built.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses an endpoint on another origin, which would carry the credential away', async () => {
    const fixture = legacySseFixture({
      endpoint: 'https://93.184.216.99/messages',
      url: 'https://93.184.216.36/mcp',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fixture.fetchMock as typeof fetch;
    try {
      const built = await buildMcpTools({
        redactEmail: true,
        logger,
        servers: [{ namespace: 'demo', server: server(fixture.BASE) }],
      });
      expect(built.tools.mcp_demo_get_weather).toBeUndefined();
      await built.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fixture.calls).not.toContainEqual({
      method: 'POST',
      path: '/messages',
    });
  });
});
