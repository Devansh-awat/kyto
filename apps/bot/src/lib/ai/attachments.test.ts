import { describe, expect, test } from 'bun:test';
import { sniffImageType } from '@/lib/ai/attachments';

const bytesOf = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part
    )
  );

describe('sniffImageType', () => {
  test('recognises the four vision formats by their magic bytes', () => {
    expect(sniffImageType(bytesOf([0x89], 'PNG\r\n'))).toBe('image/png');
    expect(sniffImageType(bytesOf([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg'
    );
    expect(sniffImageType(bytesOf('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(bytesOf('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe(
      'image/webp'
    );
  });

  test('a text file renamed .png is not an image', () => {
    expect(sniffImageType(bytesOf('hello, this is not a png'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});
