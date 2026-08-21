import { describe, expect, test } from 'bun:test';
import { checkMcpUrl, isPrivateAddress } from './mcp-url';

describe('isPrivateAddress', () => {
  test('catches the ranges a bot can reach from inside its own network', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      // The cloud metadata address — the reason this exists.
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test('leaves real public addresses alone', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '2606:4700::1',
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

describe('checkMcpUrl', () => {
  test('accepts an ordinary public endpoint', () => {
    const result = checkMcpUrl('https://mcp.example.com/v1');
    expect(result.ok).toBe(true);
  });

  test('refuses a non-http scheme', () => {
    expect(checkMcpUrl('file:///etc/passwd').ok).toBe(false);
    expect(checkMcpUrl('not a url').ok).toBe(false);
    expect(checkMcpUrl(undefined).ok).toBe(false);
  });

  test('refuses kyto’s own network', () => {
    for (const url of [
      'http://localhost:8080/mcp',
      'http://127.0.0.1/mcp',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:3000/mcp',
      'http://postgres.internal/mcp',
      'http://db.local/mcp',
      'http://10.0.0.5/mcp',
    ]) {
      expect(checkMcpUrl(url).ok).toBe(false);
    }
  });
});
