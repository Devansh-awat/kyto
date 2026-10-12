import { describe, expect, test } from 'bun:test';
import { createSideChunks } from './side-chunks';

describe('createSideChunks', () => {
  test('yields a side chunk while the source is still waiting', async () => {
    const side = createSideChunks<string>();
    let release: (() => void) | undefined;
    async function* source() {
      yield 'a';
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield 'b';
    }
    const seen: string[] = [];
    for await (const chunk of side.merge(source())) {
      seen.push(chunk);
      if (chunk === 'a') {
        setTimeout(() => side.push('side'), 0);
      }
      if (chunk === 'side') {
        release?.();
      }
    }
    expect(seen).toEqual(['a', 'side', 'b']);
  });

  test('yields a chunk pushed before the first source item first', async () => {
    const side = createSideChunks<string>();
    async function* source() {
      side.push('side');
      await Promise.resolve();
      yield 'a';
    }
    const seen: string[] = [];
    for await (const chunk of side.merge(source())) {
      seen.push(chunk);
    }
    expect(seen).toEqual(['side', 'a']);
  });
});
