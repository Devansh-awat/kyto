import { describe, expect, test } from 'bun:test';

// Set before the first redaction reads the environment (it is read once).
process.env.REDACT_TEST_API_KEY = 'sk-test-0123456789abcdef';
process.env.REDACT_TEST_PORT = '3000000000000000';

const { redactSecrets, redactSecretsDeep, registerSecret, setRedactionAlert } =
  await import('./redact');

describe('redactSecrets', () => {
  test('replaces a secret-named env value with its name', () => {
    expect(redactSecrets('key is sk-test-0123456789abcdef!', 'test')).toBe(
      'key is [redacted REDACT_TEST_API_KEY]!'
    );
  });

  test('leaves values of vars whose name is not secret-shaped', () => {
    expect(redactSecrets('port 3000000000000000', 'test')).toBe(
      'port 3000000000000000'
    );
  });

  test('catches a runtime-registered secret', () => {
    registerSecret({ label: 'a test key', value: 'runtime-secret-value-42' });
    expect(redactSecrets('got runtime-secret-value-42', 'test')).toBe(
      'got [redacted a test key]'
    );
  });

  test('reports the label, never the value', () => {
    const hits: string[][] = [];
    setRedactionAlert(({ fresh }) => hits.push(fresh));
    redactSecrets('sk-test-0123456789abcdef', 'alert test');
    expect(hits.flat().join()).not.toContain('sk-test');
  });
});

describe('redactSecretsDeep', () => {
  test('walks plain objects and arrays, leaves bytes alone', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = redactSecretsDeep(
      { bytes, nested: ['x sk-test-0123456789abcdef'], ok: 1 },
      'test'
    );
    expect(out.nested[0]).toBe('x [redacted REDACT_TEST_API_KEY]');
    expect(out.bytes).toBe(bytes);
    expect(out.ok).toBe(1);
  });
});
