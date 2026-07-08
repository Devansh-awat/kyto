// A side-channel that lets a tool (currently the subagent) push its own task
// cards into the live turn plan, interleaved with the model's own stream. Tools
// can't yield into the parent stream directly — they return a value — so the
// subagent pushes StreamChunks here and mergeStream races them into the plan.

type Resolver<T> = (result: IteratorResult<T>) => void;

export class ChunkChannel<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Resolver<T>[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

/**
 * Yield items from `primary` and `channel` as they arrive. Ends when `primary`
 * is exhausted (the channel is closed then so its iterator finishes). The
 * channel is always closed on exit, so a throw from `primary` can't leak it.
 */
export async function* mergeStream<T>(
  primary: AsyncGenerator<T>,
  channel: ChunkChannel<T>
): AsyncGenerator<T> {
  const secondary = channel[Symbol.asyncIterator]();
  let primaryNext = primary.next().then((r) => ['p', r] as const);
  let secondaryNext = secondary.next().then((r) => ['s', r] as const);
  let primaryDone = false;
  let secondaryDone = false;
  try {
    while (!(primaryDone && secondaryDone)) {
      const racers: Promise<readonly ['p' | 's', IteratorResult<T>]>[] = [];
      if (!primaryDone) {
        racers.push(primaryNext);
      }
      if (!secondaryDone) {
        racers.push(secondaryNext);
      }
      const [source, result] = await Promise.race(racers);
      if (source === 'p') {
        if (result.done) {
          primaryDone = true;
          channel.close();
        } else {
          yield result.value;
          primaryNext = primary.next().then((r) => ['p', r] as const);
        }
      } else if (result.done) {
        secondaryDone = true;
      } else {
        yield result.value;
        secondaryNext = secondary.next().then((r) => ['s', r] as const);
      }
    }
  } finally {
    channel.close();
  }
}
