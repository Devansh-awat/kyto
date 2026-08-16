import { describe, expect, test } from 'bun:test';
import { normalizeMcpAuthorization } from './mcp';

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
