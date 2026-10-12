// Chunks that belong in the plan but come from outside the model's stream —
// mid-turn compaction runs inside the SDK's prepareStep, while the stream it
// would report through sits waiting for the next step to start. `merge` yields
// them as soon as they are pushed, interleaved with the stream's own chunks.
export function createSideChunks<T>() {
  const queued: T[] = [];
  let wake: (() => void) | undefined;
  return {
    push(chunk: T): void {
      queued.push(chunk);
      wake?.();
    },
    async *merge(source: AsyncIterable<T>): AsyncGenerator<T> {
      const iterator = source[Symbol.asyncIterator]();
      let next = iterator.next();
      try {
        while (true) {
          for (let chunk = queued.shift(); chunk !== undefined; ) {
            yield chunk;
            chunk = queued.shift();
          }
          const woken = new Promise<'woken'>((resolve) => {
            wake = () => resolve('woken');
          });
          const winner = await Promise.race([next, woken]);
          wake = undefined;
          if (winner === 'woken') {
            continue;
          }
          if (winner.done) {
            yield* queued.splice(0);
            return;
          }
          yield winner.value;
          next = iterator.next();
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}
