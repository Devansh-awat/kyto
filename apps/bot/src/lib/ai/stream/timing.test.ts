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
      tools: [],
      totalMs: 13_000,
      ttftMs: 4000,
    });
  });

  test('names the slowest tools and measures generation speed', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    timer.observe('start-step');
    c.set(500);
    timer.observe({ toolCallId: 'a', toolName: 'bash', type: 'tool-call' });
    timer.observe({ toolCallId: 'b', toolName: 'opencode', type: 'tool-call' });
    c.set(1500);
    timer.observe({ toolCallId: 'a', type: 'tool-result' });
    c.set(9500);
    timer.observe({ toolCallId: 'b', type: 'tool-result' });
    timer.observe({ type: 'finish-step', usage: { outputTokens: 30 } });
    timer.observe('start-step');
    c.set(10_000);
    timer.observe('text-delta');
    c.set(12_000);
    timer.observe('text-delta');
    timer.observe({ type: 'finish-step', usage: { outputTokens: 100 } });
    expect(timer.summary()).toMatchObject({
      // Step one's output came in one burst; step two wrote 100 in 2s.
      outputTokensPerSecond: 50,
      tools: [
        { ms: 9000, name: 'opencode' },
        { ms: 1000, name: 'bash' },
      ],
      ttftMs: 500,
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
