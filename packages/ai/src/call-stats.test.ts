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
  test("a thinking step that then calls a tool; the thinking's text isn't counted", () => {
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
      finishReason: 'tool-calls',
      usage: {
        inputTokenDetails: { cacheReadTokens: 9000 },
        inputTokens: 12_000,
        outputTokenDetails: { reasoningTokens: 7, textTokens: 0 },
        outputTokens: 19,
        raw: { prompt_tokens_details: { cache_write_tokens: 2500 } },
      },
    });
    expect(meter.summary()).toEqual({
      steps: [
        {
          cacheReadTokens: 9000,
          cacheWriteTokens: 2500,
          finishReason: 'tool-calls',
          inputTokens: 12_000,
          ms: 2000,
          outputTokens: 19,
          reasoningTokens: 7,
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

  test('a request that dies is a failed step, labelled by name and status only', () => {
    const time = clock();
    const meter = createCallMeter({ now: time.now });
    meter.onStart();
    time.set(300);
    meter.onChunk('reasoning-delta');
    time.set(5000);
    meter.onError(
      Object.assign(new Error('prompt text the error quoted'), {
        name: 'AI_APICallError',
        statusCode: 502,
      })
    );
    meter.close('error');
    expect(meter.summary()?.steps).toEqual([
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        error: 'AI_APICallError 502',
        finishReason: 'error',
        inputTokens: 0,
        ms: 5000,
        outputTokens: 0,
        reasoningTokens: 0,
        textChars: 0,
        textTokens: 0,
        textWords: 0,
        toolInputChars: 0,
        toolInputWords: 0,
        ttftMs: 300,
      },
    ]);
  });

  test('a stop mid-request is aborted; a call that ended cleanly adds nothing', () => {
    const time = clock();
    const meter = createCallMeter({ now: time.now });
    meter.onStart();
    time.set(800);
    meter.onEnd({
      content: [{ text: 'hi', type: 'text' }],
      finishReason: 'length',
      usage: { outputTokens: 1 },
    });
    meter.close('error');
    meter.onStart();
    time.set(1500);
    meter.close('aborted');
    const steps = meter.summary()?.steps ?? [];
    expect(steps.map((step) => step.finishReason)).toEqual([
      'length',
      'aborted',
    ]);
    expect(steps[1]?.ms).toBe(700);
    expect(steps[1]?.error).toBeUndefined();
  });
});
