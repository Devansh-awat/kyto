import { describe, expect, test } from 'bun:test';
import { keepable } from './message-revisions';

const kytoIds = ['U0KYTO'];

describe('keepable', () => {
  test('keeps an ordinary message', () => {
    expect(keepable({ kytoIds, text: 'please do X' })).toBe(true);
  });

  test('never keeps a ## message, even after a mention', () => {
    expect(keepable({ kytoIds, text: '## just us' })).toBe(false);
    expect(keepable({ kytoIds, text: '<@U0OTHER> ## just us' })).toBe(false);
  });

  test('never keeps a !secret question', () => {
    expect(keepable({ kytoIds, text: '!secret what is my score' })).toBe(false);
    expect(keepable({ kytoIds, text: '<@U0KYTO> !secret hi' })).toBe(false);
  });

  test('keeps a <> message only when it pinged kyto', () => {
    expect(keepable({ kytoIds, text: '&lt;&gt; <@U0OTHER> do it' })).toBe(false);
    expect(keepable({ kytoIds, text: '<> <@U0KYTO> do it' })).toBe(true);
    expect(keepable({ kytoIds, text: '<@U0KYTO> &lt;&gt; do it' })).toBe(true);
  });
});
