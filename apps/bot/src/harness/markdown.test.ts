import { describe, expect, test } from 'bun:test';
import {
  disambiguateBareUrls,
  neutralizeBroadcast,
  restoreAnnotatedMentions,
} from './markdown';

describe('restoreAnnotatedMentions', () => {
  // The bug this exists for: the agent is SHOWN "@devansh (U085KKYFA6Q)" and
  // copies that form back, which Slack renders as plain text — the person is
  // named but never pinged.
  test('turns an annotated mention back into a real ping', () => {
    expect(restoreAnnotatedMentions('@devansh (U085KKYFA6Q): hi')).toBe(
      '<@U085KKYFA6Q>: hi'
    );
  });

  test('handles display names with spaces and parentheses', () => {
    expect(
      restoreAnnotatedMentions('@Lily - (KitKat) (U0B2VTYER33) said so')
    ).toBe('<@U0B2VTYER33> said so');
  });

  test('handles bot and W-prefixed ids', () => {
    expect(restoreAnnotatedMentions('@gork2 (U09NCF07DP1)')).toBe(
      '<@U09NCF07DP1>'
    );
    expect(restoreAnnotatedMentions('@someone (W012ABCDE)')).toBe(
      '<@W012ABCDE>'
    );
  });

  test('leaves an already-correct mention alone', () => {
    expect(restoreAnnotatedMentions('hey <@U085KKYFA6Q>')).toBe(
      'hey <@U085KKYFA6Q>'
    );
  });

  test('does not touch ordinary prose ending in a parenthesis', () => {
    expect(restoreAnnotatedMentions('email me (please) about @stuff')).toBe(
      'email me (please) about @stuff'
    );
    expect(restoreAnnotatedMentions('the flag (UPPER) is set')).toBe(
      'the flag (UPPER) is set'
    );
  });

  test('leaves ids inside fenced code alone', () => {
    // An id in a code block is being quoted, not addressed — rewriting it would
    // corrupt a pasted API payload.
    const code = ['```', '@devansh (U085KKYFA6Q)', '```'].join('\n');
    expect(restoreAnnotatedMentions(code)).toBe(code);
  });

  test('does not span lines', () => {
    const text = '@devansh\n(U085KKYFA6Q)';
    expect(restoreAnnotatedMentions(text)).toBe(text);
  });

  test('cannot smuggle a broadcast past the neutralizer', () => {
    // It only ever emits <@ID>, never a <!channel> control token, so the
    // broadcast strip that runs after it still holds.
    const restored = restoreAnnotatedMentions('@channel (U085KKYFA6Q) <!here>');
    expect(neutralizeBroadcast(restored)).not.toContain('<!here>');
  });
});

describe('disambiguateBareUrls', () => {
  // Reported twice: the link text read right and the click 404'd, because
  // Slack's markdown block ran the autolink past the closing bold marker.
  test('keeps a closing bold marker out of the href', () => {
    expect(
      disambiguateBareUrls('**Live: https://kyto.dino.icu/jacob-cv/**')
    ).toBe(
      '**Live: [https://kyto.dino.icu/jacob-cv/](https://kyto.dino.icu/jacob-cv/)**'
    );
  });

  test('keeps a following code span out of the href', () => {
    expect(
      disambiguateBareUrls('The PR: https://github.com/o/r/pull/14`Add thing`')
    ).toBe(
      'The PR: [https://github.com/o/r/pull/14](https://github.com/o/r/pull/14)`Add thing`'
    );
  });

  // A plain bare URL must stay bare: Slack unfurls those (canvas, file,
  // message permalink, profile), and an explicit link loses the preview.
  test('leaves an unambiguous bare URL alone', () => {
    expect(disambiguateBareUrls('see https://example.com/x for more')).toBe(
      'see https://example.com/x for more'
    );
    expect(disambiguateBareUrls('done: https://example.com/x.')).toBe(
      'done: https://example.com/x.'
    );
  });

  test('leaves an already-explicit link and a Slack angle token alone', () => {
    expect(disambiguateBareUrls('*[label](https://example.com)*')).toBe(
      '*[label](https://example.com)*'
    );
    expect(disambiguateBareUrls('<https://example.com|label>')).toBe(
      '<https://example.com|label>'
    );
  });

  test('is idempotent', () => {
    const once = disambiguateBareUrls('**https://example.com/a**');
    expect(disambiguateBareUrls(once)).toBe(once);
  });

  test('leaves fenced code and inline code untouched', () => {
    const fenced = '```\ncurl https://example.com/a*\n```';
    expect(disambiguateBareUrls(fenced)).toBe(fenced);
    expect(disambiguateBareUrls('`https://example.com/a*`')).toBe(
      '`https://example.com/a*`'
    );
  });
});
