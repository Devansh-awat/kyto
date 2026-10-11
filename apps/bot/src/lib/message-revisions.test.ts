import { describe, expect, test } from 'bun:test';
import { keepable } from './message-revisions';

const kytoIds = ['UKYTO'];

describe('keepable', () => {
  test('keeps an ordinary message', () => {
    expect(keepable({ kytoIds, text: 'please do X' })).toBe(true);
  });

  test('never keeps a ## message, even after a mention', () => {
    expect(keepable({ kytoIds, text: '## just us' })).toBe(false);
    expect(keepable({ kytoIds, text: '<@UOTHER> ## just us' })).toBe(false);
  });

  test('never keeps a !secret question', () => {
    expect(keepable({ kytoIds, text: '!secret what is my score' })).toBe(false);
    expect(keepable({ kytoIds, text: '<@UKYTO> !secret hi' })).toBe(false);
  });

  test('keeps a <> message only when it pinged kyto', () => {
    expect(keepable({ kytoIds, text: '&lt;&gt; <@UOTHER> do it' })).toBe(false);
    expect(keepable({ kytoIds, text: '<> <@UKYTO> do it' })).toBe(true);
    expect(keepable({ kytoIds, text: '<@UKYTO> &lt;&gt; do it' })).toBe(true);
  });
});
