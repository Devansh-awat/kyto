import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { capContextImages } from './image-cap';

const image = (n: number) => ({
  data: new Uint8Array([n]),
  mediaType: 'image/png',
  type: 'file' as const,
});

const viewing = (n: number): ModelMessage => ({
  content: [image(n), { text: `viewing ${n}`, type: 'text' }],
  role: 'user',
});

describe('capContextImages', () => {
  test('returns the same array when under the cap', () => {
    const messages = [viewing(1), viewing(2)];
    expect(capContextImages({ max: 2, messages })).toBe(messages);
  });

  test('drops the oldest images first and keeps the text around them', () => {
    const messages = [viewing(1), viewing(2), viewing(3)];
    const capped = capContextImages({ max: 2, messages });
    const first = capped[0]?.content;
    expect(Array.isArray(first) && first[0]).toMatchObject({ type: 'text' });
    expect(Array.isArray(first) && first[1]).toMatchObject({
      text: 'viewing 1',
    });
    expect(capped[1]).toBe(messages[1]);
    expect(capped[2]).toBe(messages[2]);
  });

  test('ignores non-image files and assistant messages', () => {
    const messages: ModelMessage[] = [
      {
        content: [
          { data: 'x', mediaType: 'application/pdf', type: 'file' },
          image(1),
        ],
        role: 'user',
      },
      { content: 'ok', role: 'assistant' },
    ];
    expect(capContextImages({ max: 1, messages })).toBe(messages);
  });
});
