import { describe, expect, test } from 'bun:test';
import { createStreamTimer } from './timing';

function clock() {
  let t = 0;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe('createStreamTimer', () => {
  test('splits model time from tool time across steps', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    c.set(0);
    timer.observe('start-step');
    c.set(4000);
    timer.observe('reasoning-delta');
    c.set(6000);
    timer.observe('tool-call');
    timer.observe('tool-call');
    c.set(7000);
    timer.observe('tool-result');
    c.set(9000);
    timer.observe('tool-error');
    timer.observe('finish-step');
    timer.observe('start-step');
    c.set(12_000);
    timer.observe('text-delta');
    c.set(13_000);
    timer.observe('text-delta');
    timer.observe('finish-step');
    expect(timer.summary()).toEqual({
      firstOutputMs: [4000, 3000],
      modelMs: 10_000,
      steps: 2,
      toolMs: 3000,
      totalMs: 13_000,
    });
  });

  test('a tool still running at the end counts as tool time', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    timer.observe('start-step');
    c.set(1000);
    timer.observe('tool-call');
    c.set(5000);
    expect(timer.summary()).toMatchObject({ modelMs: 1000, toolMs: 4000 });
  });
});
