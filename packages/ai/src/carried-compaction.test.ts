import { afterAll, describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { streamAttempt } from './agent';
import { COMPACT_INSTRUCTION } from './context-trim';

// A local OpenAI-compatible endpoint that records each request and answers:
// a plain JSON completion for the summary call, a short SSE stream otherwise.
const requests: { messages: { content: unknown; role: string }[] }[] = [];
const server = Bun.serve({
  async fetch(request) {
    const body = (await request.json()) as {
      messages: { content: unknown; role: string }[];
      stream?: boolean;
    };
    requests.push(body);
    const text = body.stream ? 'answer' : 'SUMMARY OF THE EARLIER RUN';
    if (!body.stream) {
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content: text, role: 'assistant' },
          },
        ],
        created: 0,
        id: 'x',
        model: 'm',
        object: 'chat.completion',
        usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 },
      });
    }
    const chunks = [
      { choices: [{ delta: { content: text, role: 'assistant' }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      {
        choices: [],
        usage: { completion_tokens: 1, prompt_tokens: 10, total_tokens: 11 },
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

const earlierRun: ModelMessage[] = [
  { content: 'look into it', role: 'user' },
  {
    content: [
      { text: 'thinking about it', type: 'reasoning' },
      {
        input: { command: 'ls' },
        toolCallId: 'c1',
        toolName: 'bash',
        type: 'tool-call',
      },
    ],
    role: 'assistant',
  },
  {
    content: [
      {
        output: { type: 'text', value: 'a.txt' },
        toolCallId: 'c1',
        toolName: 'bash',
        type: 'tool-result',
      },
    ],
    role: 'tool',
  },
  { content: 'found a.txt', role: 'assistant' },
];

async function run(
  priorInputTokens: number,
  carried: 'prior' | 'continue' = 'prior'
): Promise<void> {
  requests.length = 0;
  const result = streamAttempt({
    ...(carried === 'prior'
      ? { priorMessages: earlierRun }
      : {
          continueFrom: earlierRun.slice(1, 3),
          history: ['an older message'],
        }),
    attempt: {
      apiKey: 'k',
      baseURL: `http://localhost:${server.port}`,
      model: 'test-model',
      provider: 'test',
    },
    holder: {},
    priorInputTokens,
    prompt: 'now the follow-up',
    system: 'system',
    tools: {},
  });
  await result.text;
}

describe('a carried conversation', () => {
  test('goes out whole while it is small', async () => {
    await run(20_000);
    expect(requests).toHaveLength(1);
    const roles = requests[0]?.messages.map((message) => message.role);
    expect(roles).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });

  test('is compacted on the first request once past the ceiling', async () => {
    await run(95_000);
    expect(requests).toHaveLength(2);
    const [summary, answer] = requests;
    expect(JSON.stringify(summary?.messages.at(-1))).toContain(
      COMPACT_INSTRUCTION.slice(0, 40)
    );
    // The summary, then the follow-up verbatim: the earlier run is gone.
    expect(answer?.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'user',
    ]);
    expect(JSON.stringify(answer?.messages)).toContain(
      'SUMMARY OF THE EARLIER RUN'
    );
    expect(JSON.stringify(answer?.messages)).toContain('now the follow-up');
    expect(JSON.stringify(answer?.messages)).not.toContain('a.txt');
  });

  test('a fallback keeps the request and the last tool round verbatim', async () => {
    await run(95_000, 'continue');
    expect(requests).toHaveLength(2);
    const answer = requests[1]?.messages ?? [];
    expect(answer.map((message) => message.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'tool',
    ]);
    expect(JSON.stringify(answer)).toContain('now the follow-up');
    expect(JSON.stringify(answer)).toContain('a.txt');
    expect(JSON.stringify(answer)).not.toContain('an older message');
  });
});
