import { describe, expect, test } from 'bun:test';
import { boundedOutput, describePriorEffects } from './inflight';

const wait = {
  at: '2026-10-12T16:28:00.000Z',
  input: '{"seconds":300}',
  status: 'started' as const,
  tool: 'wait',
};

describe('describePriorEffects', () => {
  // #77: "wait 5 minutes then grade" was cut by a deploy and the resumed turn
  // didn't know how long it had already waited.
  test('a cut wait is resumed for the time left', () => {
    const text = describePriorEffects([wait], new Date('2026-10-12T16:31:37Z'));
    expect(text).toContain('call wait for the 83s still left');
    expect(text).toContain('no outward action');
  });

  test('a cut wait that is already over is not waited again', () => {
    const text = describePriorEffects([wait], new Date('2026-10-12T16:40:00Z'));
    expect(text).toContain("Don't wait again");
  });

  test('a finished wait is not mentioned', () => {
    expect(
      describePriorEffects([{ ...wait, status: 'done' }], new Date())
    ).not.toContain('wait');
  });
});

describe('boundedOutput', () => {
  // #144 reopened: NULs inside an OBJECT result (bash's stdout) survived.
  test('scrubs NULs and lone surrogates at any depth, keeps emoji', () => {
    const scrubbed = boundedOutput({
      exitCode: 0,
      stdout: 'ELF\u0002\u0001\u0000\u0000 🙂 \uD800x',
      lines: ['a\u0000b'],
    });
    expect(JSON.stringify(scrubbed)).not.toContain('\\u0000');
    expect(scrubbed).toEqual({
      exitCode: 0,
      lines: ['ab'],
      stdout: 'ELF\u0002\u0001 🙂 \uFFFDx',
    });
  });

  test('a result too big is cut to a string', () => {
    const cut = boundedOutput({ stdout: 'x'.repeat(70_000) });
    expect(typeof cut).toBe('string');
    expect(String(cut)).toContain('cut at 60000 characters');
  });
});
