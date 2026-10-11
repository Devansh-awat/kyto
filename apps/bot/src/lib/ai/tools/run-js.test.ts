import { describe, expect, test } from 'bun:test';
import { runJs } from './run-js';

const run = runJs;

describe('runJs', () => {
  test('returns the last expression and console output', async () => {
    expect(await run('console.log("hi", {a: 1}); 19 * 7')).toEqual({
      output: 'hi {"a":1}',
      result: '133',
      success: true,
    });
  });

  test('stops an infinite loop', async () => {
    const result = await run('while (true) {}');
    expect(result).toMatchObject({ success: false });
  });

  test('has no host access', async () => {
    expect(
      await run('typeof fetch + typeof require + typeof process')
    ).toMatchObject({
      result: 'undefinedundefinedundefined',
    });
  });

  test('reports a thrown error', async () => {
    expect(await run('throw new Error("nope")')).toMatchObject({
      success: false,
    });
  });
});
