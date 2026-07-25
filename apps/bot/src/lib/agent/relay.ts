import type { StreamChunk } from '@/harness';

/**
 * A side channel for task cards that originate OUTSIDE the model stream, so they
 * can be rendered into the current turn's plan block.
 *
 * Subagents need this. A subagent's whole run — its thinking, its tool calls, its
 * report — belongs in the plan block of the turn that spawned it, not in a
 * separate Slack message. But a subagent runs inside a tool `execute`, buried in
 * the AI SDK's `streamText`, with no way to yield into the generator that
 * `streamSegmented` is draining. Worse, while a FOREGROUND subagent runs the
 * parent generator is blocked on exactly that tool call, so nothing can come out
 * of it at all until the subagent is finished.
 *
 * So the subagent pushes here, and `streamSegmented` races this against the model
 * stream. Cards land in the plan as they happen instead of arriving in one lump
 * after the fact.
 *
 * Buffered, not signalled: `take()` is the source of truth and `wait()` only
 * wakes a sleeper up. A push that lands while the racer is committed to the model
 * stream therefore cannot be lost — it is sitting in the buffer for the next round.
 */
export interface ChunkRelay {
  /** Stop accepting chunks. Later pushes are dropped rather than queued forever. */
  close(): void;
  /** Queue a chunk for the current turn's plan. Ignored once closed. */
  push(chunk: StreamChunk): void;
  /** The next buffered chunk, or undefined when the buffer is empty. */
  take(): StreamChunk | undefined;
  /** Resolves the next time a chunk is pushed (or the relay closes). */
  wait(): Promise<void>;
}

export function createChunkRelay(): ChunkRelay {
  const buffer: StreamChunk[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  // One shared promise per idle period: every waiter gets the same one, and it is
  // replaced only after being resolved, so a push always wakes whoever is asleep.
  let sleeping: Promise<void> | undefined;

  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    sleeping = undefined;
    resolve?.();
  };

  return {
    close(): void {
      closed = true;
      notify();
    },
    push(chunk: StreamChunk): void {
      if (closed) {
        return;
      }
      buffer.push(chunk);
      notify();
    },
    take(): StreamChunk | undefined {
      return buffer.shift();
    },
    wait(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      sleeping ??= new Promise<void>((resolve) => {
        wake = resolve;
      });
      return sleeping;
    },
  };
}
