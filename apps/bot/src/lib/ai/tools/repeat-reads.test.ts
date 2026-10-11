import { describe, expect, test } from 'bun:test';
import { rememberRepeatReads } from './repeat-reads';

describe('rememberRepeatReads', () => {
  test('an identical read returns the earlier result, marked', async () => {
    let calls = 0;
    const read = rememberRepeatReads((input: { a?: string; b?: string }) => {
      calls += 1;
      return Promise.resolve({ got: input.a });
    });
    await read({ a: 'x', b: '' });
    const again = await read({ b: undefined, a: 'x' });
    expect(calls).toBe(1);
    expect(again.got).toBe('x');
    expect(again.repeat).toBeString();
  });

  test('a different read, or one that threw, runs for real', async () => {
    let calls = 0;
    const read = rememberRepeatReads((input: { a: string }) => {
      calls += 1;
      if (input.a === 'boom') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ got: input.a });
    });
    await read({ a: 'x' });
    await read({ a: 'y' });
    await read({ a: 'boom' }).catch(() => undefined);
    await read({ a: 'boom' }).catch(() => undefined);
    expect(calls).toBe(4);
  });
});
