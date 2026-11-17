import { describe, expect, test } from 'bun:test';
import { LazySandbox } from './lazy-sandbox';

const MB = 1024 * 1024;

/** A LazySandbox whose already-materialized sandbox streams `chunks`. */
function sandboxStreaming(chunks: Uint8Array[]) {
  let pulled = 0;
  let cancelled = false;
  const lazy = new LazySandbox({
    apiKey: 'test',
    logger: { info: () => undefined, warn: () => undefined } as never,
  });
  const fake = {
    files: {
      read: () =>
        Promise.resolve(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            pull(controller) {
              const next = chunks[pulled];
              pulled++;
              if (next) {
                controller.enqueue(next);
              } else {
                controller.close();
              }
            },
          })
        ),
    },
  };
  (lazy as unknown as { sandbox: unknown }).sandbox = fake;
  return {
    lazy,
    stats: () => ({ cancelled, pulled }),
  };
}

describe('readBinaryFile', () => {
  test('joins the streamed chunks into the whole file', async () => {
    const { lazy } = sandboxStreaming([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    ]);
    expect(
      Array.from((await lazy.readBinaryFile({ path: '/f' })) ?? [])
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('an empty file reads as empty, not missing', async () => {
    const { lazy } = sandboxStreaming([]);
    const bytes = await lazy.readBinaryFile({ path: '/empty' });
    expect(bytes?.byteLength).toBe(0);
  });

  test('a file past the cap is refused as it streams, not read whole', async () => {
    // 300 chunks of 1 MB: the read must stop just past 256 MB.
    const chunk = new Uint8Array(MB);
    const { lazy, stats } = sandboxStreaming(
      Array.from({ length: 300 }, () => chunk)
    );
    await expect(lazy.readBinaryFile({ path: '/big.bin' })).rejects.toThrow(
      /too large to read whole/
    );
    expect(stats().pulled).toBeLessThan(260);
    expect(stats().cancelled).toBe(true);
  });

  test('a missing sandbox file reads as null', async () => {
    const lazy = new LazySandbox({
      apiKey: 'test',
      logger: { info: () => undefined, warn: () => undefined } as never,
    });
    (lazy as unknown as { sandbox: unknown }).sandbox = {
      files: {
        read: () => Promise.reject(new Error('Path /nope not found')),
      },
    };
    expect(await lazy.readBinaryFile({ path: '/nope' })).toBeNull();
  });
});
