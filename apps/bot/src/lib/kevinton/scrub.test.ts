import { describe, expect, test } from 'bun:test';
import { scrubForPublic } from './scrub';

describe('scrubForPublic', () => {
  test('cuts slack mentions, ids, links, timestamps and emails', () => {
    const out = scrubForPublic(
      'asked by <@U0BD3555UCQ> in <#C06QV2T1P4G|general> (C06QV2T1P4G) at 1710818631.730789, see https://hackclub.slack.com/archives/C1/p1 or mail a.b@example.com'
    );
    expect(out).not.toMatch(
      /U0BD3555UCQ|C06QV2T1P4G|1710818631|example\.com|slack\.com/
    );
    expect(out).toContain('[slack mention]');
    expect(out).toContain('[email]');
  });

  test('leaves ordinary issue text alone', () => {
    const text =
      'The `browser` tool fails when CDP on :9222 is slow; see apps/bot/src/lib/browser/cloak.ts line 42. Error: ECONNREFUSED, value UNDEFINED, CONNECTION reset.';
    expect(scrubForPublic(text)).toBe(text);
  });
});
