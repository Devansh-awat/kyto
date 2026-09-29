import { describe, expect, test } from 'bun:test';
import { mayCarryPat } from './host';

describe('mayCarryPat', () => {
  test('the three GitHub hosts over https', () => {
    expect(mayCarryPat('https://api.github.com/repos/a/b')).toBe(true);
    expect(mayCarryPat('https://github.com/a/b.git/info/refs')).toBe(true);
    expect(mayCarryPat('https://uploads.github.com/repos/a/b')).toBe(true);
  });

  test('never Pages, lookalikes, userinfo, ports or plain http', () => {
    expect(mayCarryPat('https://someone.github.io/x')).toBe(false);
    expect(mayCarryPat('https://api.github.com.evil.example/x')).toBe(false);
    expect(mayCarryPat('https://api.github.com@evil.example/x')).toBe(false);
    expect(mayCarryPat('https://evil.example\\.github.com/x')).toBe(false);
    expect(mayCarryPat('https://api.github.com:8443/x')).toBe(false);
    expect(mayCarryPat('http://api.github.com/x')).toBe(false);
    expect(mayCarryPat('not a url')).toBe(false);
  });

  test('a path that looks like a host does not move the host', () => {
    expect(mayCarryPat('https://api.github.com/@evil.example/x')).toBe(true);
    expect(mayCarryPat('https://api.github.com//evil.example')).toBe(true);
  });
});
