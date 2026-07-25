import { describe, expect, test } from 'bun:test';
import type { StreamChunk } from '@/harness';
import { createChunkRelay } from './relay';

const card = (id: string): StreamChunk => ({
  id,
  status: 'complete',
  title: id,
  type: 'task_update',
});

describe('createChunkRelay', () => {
  test('buffers pushes so none are lost while nobody is waiting', () => {
    // This is the whole reason the relay is buffered rather than a bare signal:
    // streamSegmented races it against the model stream, and a push that lands
    // while the racer is committed to the model stream must survive until the
    // next round.
    const relay = createChunkRelay();
    relay.push(card('a'));
    relay.push(card('b'));
    expect(relay.take()).toMatchObject({ id: 'a' });
    expect(relay.take()).toMatchObject({ id: 'b' });
    expect(relay.take()).toBeUndefined();
  });

  test('wait resolves on the next push', async () => {
    const relay = createChunkRelay();
    let woke = false;
    const sleeper = relay.wait().then(() => {
      woke = true;
    });
    expect(woke).toBe(false);
    relay.push(card('a'));
    await sleeper;
    expect(woke).toBe(true);
    expect(relay.take()).toMatchObject({ id: 'a' });
  });

  test('every concurrent waiter is woken by one push', async () => {
    const relay = createChunkRelay();
    const waiters = [relay.wait(), relay.wait(), relay.wait()];
    relay.push(card('a'));
    // A stale shared promise that was resolved but not replaced would hang one of
    // these forever, stalling the plan for the rest of the turn.
    await Promise.all(waiters);
    expect(relay.take()).toMatchObject({ id: 'a' });
  });

  test('wait after a resolved wait still sleeps until the next push', async () => {
    const relay = createChunkRelay();
    const first = relay.wait();
    relay.push(card('a'));
    await first;
    relay.take();
    let woke = false;
    const second = relay.wait().then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    relay.push(card('b'));
    await second;
    expect(woke).toBe(true);
  });

  test('closing wakes sleepers and drops later pushes', async () => {
    // A background subagent outlives its turn. Once the plan it was rendering
    // into is gone, its pushes must stop rather than queue forever — and a
    // sleeper must not hang waiting for a push that will never come.
    const relay = createChunkRelay();
    const sleeper = relay.wait();
    relay.close();
    await sleeper;
    relay.push(card('late'));
    expect(relay.take()).toBeUndefined();
    // A wait on a closed relay resolves immediately rather than hanging.
    await relay.wait();
  });

  test('chunks buffered before close are still drainable', () => {
    const relay = createChunkRelay();
    relay.push(card('a'));
    relay.close();
    expect(relay.take()).toMatchObject({ id: 'a' });
  });
});
