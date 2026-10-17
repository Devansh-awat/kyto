import { afterAll, describe, expect, test } from 'bun:test';
import { streamAttempt } from './agent';
import { type SpendRecord, setSpendSink } from './spend';

// A local OpenAI-compatible endpoint: refuses the request when the prompt
// says so, else streams a short answer with usage.
const server = Bun.serve({
  async fetch(request) {
    const body = (await request.json()) as {
      messages: { content: unknown; role: string }[];
    };
    if (JSON.stringify(body.messages).includes('refuse me')) {
      return Response.json(
        { error: { message: 'bad request', type: 'invalid_request_error' } },
        { status: 400 }
      );
    }
    const chunks = [
      { choices: [{ delta: { content: 'hi', role: 'assistant' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      {
        choices: [],
        usage: {
          completion_tokens: 1,
          prompt_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 1000 },
          total_tokens: 1201,
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
afterAll(() => server.stop(true));

async function bill(prompt: string): Promise<SpendRecord[]> {
  const records: SpendRecord[] = [];
  setSpendSink((record) => records.push(record));
  const result = streamAttempt({
    attempt: {
      apiKey: 'k',
      baseURL: `http://localhost:${server.port}`,
      model: 'test-model',
      provider: 'test',
    },
    // A known model skips the background scan for the routed slug: with it,
    // the SDK reads this local server's stream as empty (production calls
    // record fine; the cause wasn't isolated).
    holder: { model: 'test-model' },
    onError: () => undefined,
    prompt,
    source: 'test',
    system: 'system',
    tools: {},
  });
  await result.consumeStream();
  // The failure path bills from a promise rejection, a tick after the stream.
  await Bun.sleep(10);
  return records;
}

describe('every call is billed with its per-request stats', () => {
  test('a finished call: input, cache and finish reason per request', async () => {
    const [record, extra] = await bill('hello');
    expect(extra).toBeUndefined();
    expect(record?.stats?.steps).toMatchObject([
      { cacheReadTokens: 1000, finishReason: 'stop', inputTokens: 1200 },
    ]);
  });

  test('a call refused on its first request is still a row, as an error', async () => {
    const [record, extra] = await bill('refuse me');
    expect(extra).toBeUndefined();
    expect(record?.outputTokens).toBe(0);
    expect(record?.stats?.steps).toMatchObject([
      { error: 'AI_APICallError 400', finishReason: 'error' },
    ]);
  });
});
