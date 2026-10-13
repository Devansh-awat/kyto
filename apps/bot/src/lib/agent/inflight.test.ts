import { describe, expect, test } from 'bun:test';
import { describePriorEffects } from './inflight';

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
