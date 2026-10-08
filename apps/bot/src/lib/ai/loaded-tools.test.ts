import { describe, expect, test } from 'bun:test';
import {
  recallLoadedTools,
  rememberLoadedTools,
  threadToolOrder,
} from './loaded-tools';

describe('threadToolOrder', () => {
  test('is the SAME state object on every turn of a thread', () => {
    // The request mutates it; the next turn must see that mutation, or the
    // tools reshuffle and the cached prompt after them is lost.
    const first = threadToolOrder('slack:C1:1.0');
    first.names.push('bash', 'loadTools');
    expect(threadToolOrder('slack:C1:1.0').names).toEqual([
      'bash',
      'loadTools',
    ]);
  });

  test('survives a later loadTools, which shares the entry', () => {
    const order = threadToolOrder('slack:C2:1.0');
    order.names.push('bash');
    rememberLoadedTools('slack:C2:1.0', ['gh']);
    expect(threadToolOrder('slack:C2:1.0')).toBe(order);
    expect(recallLoadedTools('slack:C2:1.0')).toEqual(['gh']);
  });

  test('is per thread', () => {
    threadToolOrder('slack:C3:1.0').names.push('bash');
    expect(threadToolOrder('slack:C4:1.0').names).toEqual([]);
  });
});
