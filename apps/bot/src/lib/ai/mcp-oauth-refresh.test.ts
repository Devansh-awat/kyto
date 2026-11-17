import { describe, expect, mock, test } from 'bun:test';

process.env.BYOK_ENCRYPTION_KEY ??= 'test-key-test-key-test-key-test-key-123';

let tokenPosts = 0;
let refuse = true;
// What a refusal answers with: 400 (invalid_grant) by default.
let refusalStatus = 400;
// When set, the token endpoint can't be reached at all, with this error.
let unreachable: Error | undefined;
// bun shares one module registry across test files: keep the real exports.
const realPublicUrl = await import('@/lib/public-url');
mock.module('@/lib/public-url', () => ({
  ...realPublicUrl,
  publicFetch: () => {
    tokenPosts++;
    if (unreachable) {
      return Promise.reject(unreachable);
    }
    return Promise.resolve(
      refuse
        ? new Response('{"error":"invalid_grant"}', { status: refusalStatus })
        : Response.json({ access_token: 'new-access', expires_in: 3600 })
    );
  },
}));
const realQueries = await import('@repo/db/queries');
mock.module('@repo/db/queries', () => ({
  ...realQueries,
  setMcpServerOauth: () => Promise.resolve(),
}));

const { encryptSecret } = await import('@/lib/byok/crypto');
const { withMcpOauth } = await import('./mcp-oauth');

function serverWith(refreshToken: string, id = 'srv-1') {
  return {
    id,
    name: 'test',
    oauth: encryptSecret(
      JSON.stringify({
        accessToken: 'old-access',
        clientId: 'client',
        expiresAt: Date.now() - 1000,
        refreshToken,
        resource: 'https://mcp.example/mcp',
        tokenEndpoint: 'https://auth.example/token',
      })
    ),
    url: 'https://mcp.example/mcp',
  } as never;
}

describe('a refused refresh grant', () => {
  test('is not re-posted on every turn', async () => {
    refuse = true;
    tokenPosts = 0;
    const server = serverWith('dead-refresh');
    for (let turn = 0; turn < 3; turn++) {
      const out = (await withMcpOauth(server)) as { authorization?: string };
      expect(out.authorization).toBe('Bearer old-access');
    }
    expect(tokenPosts).toBe(1);
  });

  test('signing in again (a new refresh token) is tried at once', async () => {
    refuse = false;
    tokenPosts = 0;
    const out = (await withMcpOauth(serverWith('fresh-refresh'))) as {
      authorization?: string;
    };
    expect(tokenPosts).toBe(1);
    expect(out.authorization).toBe('Bearer new-access');
  });

  test('an outage (5xx) is not held back: the next turn tries again', async () => {
    refuse = true;
    refusalStatus = 503;
    tokenPosts = 0;
    try {
      const server = serverWith('blip-refresh', 'srv-2');
      await withMcpOauth(server);
      await withMcpOauth(server);
      expect(tokenPosts).toBe(2);
    } finally {
      refusalStatus = 400;
    }
  });

  test("a certificate that doesn't match the host is held back like a refusal", async () => {
    // What prod hit: the endpoint's TLS certificate named another host. That
    // stays broken until someone fixes it, so it is not re-tried every turn.
    tokenPosts = 0;
    unreachable = new Error(
      'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://auth.example/token".'
    );
    try {
      const server = serverWith('tls-refresh', 'srv-3');
      await withMcpOauth(server);
      await withMcpOauth(server);
      expect(tokenPosts).toBe(1);
    } finally {
      unreachable = undefined;
    }
  });

  test('a timeout is not held back', async () => {
    tokenPosts = 0;
    unreachable = Object.assign(new Error('The operation timed out.'), {
      name: 'TimeoutError',
    });
    try {
      const server = serverWith('slow-refresh', 'srv-4');
      await withMcpOauth(server);
      await withMcpOauth(server);
      expect(tokenPosts).toBe(2);
    } finally {
      unreachable = undefined;
    }
  });
});
