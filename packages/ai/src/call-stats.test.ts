import { describe, expect, test } from 'bun:test';
import { createCallMeter } from './call-stats';

function clock() {
  let at = 0;
  return {
    now: () => at,
    set: (next: number) => {
      at = next;
    },
  };
}

describe('createCallMeter', () => {
  test('a thinking step that then calls a tool', () => {
    const time = clock();
    const meter = createCallMeter({ now: time.now });
    meter.onStart();
    time.set(400);
    meter.onChunk('reasoning-delta');
    time.set(1400);
    meter.onChunk('reasoning-delta');
    time.set(1500);
    meter.onChunk('tool-input-start');
    time.set(1600);
    meter.onChunk('tool-input-delta');
    time.set(2000);
    meter.onEnd({
      content: [
        { text: 'I should look this up.', type: 'reasoning' },
        { input: { query: 'bun test' }, type: 'tool-call' },
      ],
      usage: {
        outputTokenDetails: { reasoningTokens: 7, textTokens: 0 },
        outputTokens: 19,
      },
    });
    expect(meter.summary()).toEqual({
      steps: [
        {
          ms: 2000,
          outputTokens: 19,
          reasoningChars: 22,
          reasoningStreamMs: 1000,
          reasoningTokens: 7,
          reasoningWords: 5,
          textChars: 0,
          textTokens: 0,
          textWords: 0,
          thinkMs: 1500,
          toolInputChars: 20,
          toolInputWords: 2,
          ttftMs: 400,
        },
      ],
    });
  });

  test('hidden thinking: the wait before the answer is still measured', () => {
    const time = clock();
    const meter = createCallMeter({ now: time.now });
    meter.onStart();
    time.set(3000);
    meter.onChunk('text-delta');
    time.set(3500);
    meter.onEnd({
      content: [{ text: 'Done, it is fixed now.', type: 'text' }],
      performance: { responseTimeMs: 3510, timeToFirstOutputMs: 2990 },
      usage: {
        outputTokenDetails: { reasoningTokens: 120, textTokens: 6 },
        outputTokens: 126,
      },
    });
    const [step] = meter.summary()?.steps ?? [];
    expect(step?.ms).toBe(3510);
    expect(step?.thinkMs).toBe(3000);
    expect(step?.ttftMs).toBe(3000);
    expect(step?.reasoningStreamMs).toBeUndefined();
    expect(step?.reasoningChars).toBe(0);
    expect(step?.textWords).toBe(5);
  });

  test("a call that wasn't streamed has no think time, and nothing measured is nothing", () => {
    const meter = createCallMeter({ now: () => 0 });
    expect(meter.summary()).toBeUndefined();
    meter.onEnd({
      content: [{ text: 'summary', type: 'text' }],
      performance: { responseTimeMs: 900 },
      usage: { outputTokens: 2 },
    });
    const [step] = meter.summary()?.steps ?? [];
    expect(step?.ms).toBe(900);
    expect(step?.thinkMs).toBeUndefined();
    expect(step?.ttftMs).toBeUndefined();
  });
});
