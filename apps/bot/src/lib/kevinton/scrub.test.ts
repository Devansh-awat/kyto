import { describe, expect, test } from 'bun:test';
import { findQuote, scrubForPublic } from './scrub';

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

describe('findQuote', () => {
  const messages = [
    'is it feasible to make our own plane with low cost?',
    'where the hell is your message, it disappeared',
  ];

  test('catches a quoted run of five words, whatever the case', () => {
    expect(
      findQuote({
        messages,
        text: 'The user asked "Is it feasible to make our own plane" and got nothing.',
      })
    ).toBe('is it feasible to make');
  });

  test('lets a paraphrase through', () => {
    expect(
      findQuote({
        messages,
        text: 'Someone asked a multi-part feasibility question; kyto posted no answer.',
      })
    ).toBeUndefined();
  });
});
