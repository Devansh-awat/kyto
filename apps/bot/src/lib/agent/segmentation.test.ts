import { describe, expect, test } from 'bun:test';
import { createSegmenter, isVisibleText } from './segmentation';

const card = { type: 'task_update' };

describe('isVisibleText', () => {
  test('real prose is visible', () => {
    expect(isVisibleText('hello')).toBe(true);
  });

  test('whitespace-only fragments are not', () => {
    // createReply never posts these, so treating them as "the model replied"
    // opened an empty message for every stretch of tools.
    for (const fragment of ['', '\n', '  ', '\n\n', '\t']) {
      expect(isVisibleText(fragment)).toBe(false);
    }
  });
});

describe('createSegmenter', () => {
  test('cards accumulate in one message before any text', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next(card)).toBe('emit');
  });

  test('text after the cards opens a new message', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next('here is what i found')).toBe('split');
    segmenter.newMessage();
    expect(segmenter.next('here is what i found')).toBe('append');
  });

  test("cards after text stay in the text's message", () => {
    const segmenter = createSegmenter();
    expect(segmenter.next('checking the repo')).toBe('append');
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next('found it')).toBe('split');
  });

  test('whitespace between tool calls does NOT split', () => {
    // The "messages with nothing written in them" bug.
    const segmenter = createSegmenter();
    expect(segmenter.next(card)).toBe('emit');
    expect(segmenter.next('\n')).toBe('append');
    expect(segmenter.next('  ')).toBe('append');
    expect(segmenter.next(card)).toBe('emit');
  });

  test('a new message starts clean', () => {
    const segmenter = createSegmenter();
    segmenter.next(card);
    segmenter.newMessage();
    expect(segmenter.next('text')).toBe('append');
  });

  test('an update to a card from an earlier message is dropped', () => {
    // GLM writes "let me check" after the call: the result arrives after the
    // split, and in the new message it would render as a failed row.
    const segmenter = createSegmenter();
    expect(segmenter.next({ id: 'call-1', type: 'task_update' })).toBe('emit');
    expect(segmenter.next('let me check')).toBe('split');
    segmenter.newMessage();
    expect(segmenter.next('let me check')).toBe('append');
    expect(segmenter.next({ id: 'call-1', type: 'task_update' })).toBe('drop');
    expect(segmenter.next({ id: 'call-2', type: 'task_update' })).toBe('emit');
  });

  test('an update to a card in this message stays in it', () => {
    const segmenter = createSegmenter();
    expect(segmenter.next('reading')).toBe('append');
    expect(segmenter.next({ id: 'call-1', type: 'task_update' })).toBe('emit');
    expect(segmenter.next({ id: 'call-1', type: 'task_update' })).toBe('emit');
  });
});
