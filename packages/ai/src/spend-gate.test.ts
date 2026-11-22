import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { streamAttempt } from './agent';
import { setSpendGate, setSpendSink } from './spend';

const STEP_COST = 0.4;
const CAP = 1;

// A model that always calls a tool, each request costing STEP_COST.
let requests = 0;
const server = Bun.serve({
  fetch() {
    requests += 1;
    const chunks = [
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  function: { arguments: '{}', name: 'again' },
                  id: `call_${requests}`,
                  index: 0,
                  type: 'function',
                },
              ],
            },
            index: 0,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
      {
        choices: [],
        usage: {
          completion_tokens: 1,
          cost: STEP_COST,
          prompt_tokens: 10,
          total_tokens: 11,
        },
      },
    ];
    const sse = `${chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ created: 0, id: 'x', model: 'm', object: 'chat.completion.chunk', ...chunk })}\n\n`
      )
      .join('')}data: [DONE]\n\n`;
    return new Response(sse, {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
  port: 0,
});
afterAll(() => {
  server.stop(true);
  setSpendGate(() => undefined);
});

async function run(provider: string) {
  let running = 0;
  let settledAt: number | undefined;
  const errors: unknown[] = [];
  let recorded = 0;
  setSpendSink((record) => {
    recorded += record.costUsd ?? 0;
  });
  setSpendGate(() => ({
    beforeRequest: () =>
      running >= CAP
        ? Promise.reject(new Error('cap reached'))
        : Promise.resolve(),
    onStep: (costUsd) => {
      running += costUsd;
    },
    settle: () => {
      settledAt = recorded;
    },
  }));
  const stop = new AbortController();
  const result = streamAttempt({
    abortSignal: stop.signal,
    attempt: {
      apiKey: 'k',
      baseURL: `http://localhost:${server.port}`,
      model: 'test-model',
      provider,
    },
    holder: { model: 'test-model' },
    onError: (error) => errors.push(error),
    prompt: 'hello',
    system: 'system',
    tools: {
      again: tool({
        execute: () => {
          if (requests >= 6) {
            stop.abort();
          }
          return 'ok';
        },
        inputSchema: z.object({}),
      }),
    },
  });
  await result.consumeStream();
  await Bun.sleep(10);
  return { errors, recorded, running, settledAt };
}

describe('the spend gate', () => {
  beforeEach(() => {
    requests = 0;
  });

  test('ends a running call on the request after its steps pass the cap', async () => {
    const { errors, recorded, settledAt } = await run('hackclub');
    expect(requests).toBe(3);
    expect(errors.map(String).join()).toContain('cap reached');
    expect(recorded).toBeCloseTo(1.2);
    // Its steps are reported before the gate lets go of them.
    expect(settledAt).toBeCloseTo(1.2);
  });

  test("leaves calls on anyone else's provider alone", async () => {
    const { running, settledAt } = await run('test');
    expect(requests).toBeGreaterThan(3);
    expect(running).toBe(0);
    expect(settledAt).toBeUndefined();
  });
});
