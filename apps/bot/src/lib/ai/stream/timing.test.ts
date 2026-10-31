import { describe, expect, test } from 'bun:test';
import { createStreamTimer, describeReasoning } from './timing';

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
    expect(timer.summary()).toMatchObject({
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
    timer.observe({
      toolCallId: 'b',
      toolName: 'codingAgent',
      type: 'tool-call',
    });
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
        { ms: 9000, name: 'codingAgent' },
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

  test('measures characters per second from the first character to the last', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    timer.observe('start-step');
    c.set(1000);
    timer.observe({ text: 'hello', type: 'text-delta' });
    c.set(2000);
    timer.observe({ text: 'x'.repeat(50), type: 'text-delta' });
    c.set(3000);
    timer.observe({ delta: 'y'.repeat(150), type: 'tool-input-delta' });
    timer.observe('finish-step');
    expect(timer.summary().outputCharsPerSecond).toBe(100);
  });

  test('a step is timed from its request, not from start-step', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    c.set(2000);
    timer.observe('start-step');
    timer.observe('text-delta');
    timer.observe('finish-step');
    c.set(5000);
    timer.observe('start-step');
    timer.observe('text-delta');
    timer.observe('finish-step');
    expect(timer.summary().firstOutputMs).toEqual([2000, 3000]);
  });

  test('a burst is not a speed', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    timer.observe('start-step');
    c.set(1000);
    timer.observe({ text: 'a', type: 'text-delta' });
    c.set(1010);
    timer.observe({ text: 'b'.repeat(500), type: 'text-delta' });
    timer.observe({ type: 'finish-step', usage: { outputTokens: 200 } });
    const summary = timer.summary();
    expect(summary.outputCharsPerSecond).toBeUndefined();
    expect(summary.outputTokensPerSecond).toBeUndefined();
  });

  test('counts thinking per step, in tokens and time only', () => {
    const c = clock();
    const timer = createStreamTimer(c.now);
    timer.observe('start-step');
    c.set(1000);
    timer.observe({ type: 'reasoning-start' });
    timer.observe({ text: 'x'.repeat(100), type: 'reasoning-delta' });
    c.set(3000);
    timer.observe({ text: 'x'.repeat(300), type: 'reasoning-delta' });
    timer.observe({ type: 'reasoning-end' });
    c.set(4000);
    timer.observe({ text: 'hi', type: 'text-delta' });
    timer.observe({
      type: 'finish-step',
      usage: {
        outputTokenDetails: { reasoningTokens: 100, textTokens: 1 },
        outputTokens: 101,
      },
    });
    // A step whose thinking summary arrived in one buffered delta.
    timer.observe('start-step');
    c.set(6000);
    timer.observe({ type: 'reasoning-start' });
    timer.observe({ text: 'summary', type: 'reasoning-delta' });
    timer.observe({ toolCallId: 't', toolName: 'bash', type: 'tool-call' });
    timer.observe({
      type: 'finish-step',
      usage: {
        outputTokenDetails: { reasoningTokens: 300, textTokens: 0 },
        outputTokens: 320,
      },
    });
    const { perStep, reasoning } = timer.summary();
    expect(reasoning).toMatchObject({
      maxStepTokens: 300,
      thinkMs: 6000,
      thinkingSteps: 2,
      tokens: 400,
    });
    expect(perStep).toEqual([
      [1000, 4000, 100, 2, 0, 101],
      [2000, 2000, 300, 0, 0, 320],
    ]);
    expect(describeReasoning(reasoning)).toMatchObject({
      tokensPerThinkSecond: 67,
      tokensPerThinkingStep: 200,
    });
  });
});
