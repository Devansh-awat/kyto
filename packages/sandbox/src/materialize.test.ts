import { describe, expect, test } from 'bun:test';
import { materializeOnce } from './lazy-sandbox';

describe('materializeOnce', () => {
  test('serializes materializations of the same session', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = materializeOnce('C1', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      return 'created';
    });
    const second = materializeOnce('C1', () => {
      order.push('second:start');
      return Promise.resolve('reconnected');
    });
    await Bun.sleep(5);
    expect(order).toEqual(['first:start']);
    release();
    expect(await Promise.all([first, second])).toEqual([
      'created',
      'reconnected',
    ]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('a failed materialization does not block the next', async () => {
    const failed = materializeOnce('C2', () =>
      Promise.reject(new Error('E2B down'))
    );
    const next = materializeOnce('C2', () => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('E2B down');
    expect(await next).toBe('ok');
  });

  test('different sessions run concurrently', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = materializeOnce('C3', async () => {
      await gate;
      order.push('slow');
    });
    await materializeOnce('C4', () => {
      order.push('fast');
      return Promise.resolve();
    });
    release();
    await slow;
    expect(order).toEqual(['fast', 'slow']);
  });
});
