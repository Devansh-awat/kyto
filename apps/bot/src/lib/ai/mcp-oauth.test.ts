import { describe, expect, test } from 'bun:test';
import { handleMcpOauth } from './mcp-oauth';

const callback = 'https://kyto.example/_mcpauth/callback';

describe('handleMcpOauth', () => {
  test('other paths are not ours', async () => {
    expect(
      await handleMcpOauth(new Request('https://kyto.example/x'), '/x')
    ).toBeNull();
  });

  // The state is encrypted and bound to the server's owner; anything else is
  // refused before a code is ever exchanged.
  test('a forged or missing state is refused', async () => {
    process.env.BYOK_ENCRYPTION_KEY ??=
      'test-key-test-key-test-key-test-key-123';
    const response = await handleMcpOauth(
      new Request(`${callback}?code=abc&state=forged`),
      '/_mcpauth/callback'
    );
    expect(response?.status).toBe(400);
    expect(await response?.text()).toContain('Link expired');
  });
});
