import { describe, expect, test } from 'bun:test';
import {
  CARRYOVER_MAX_RESULTS,
  CARRYOVER_OUTPUT_MAX,
  carriedMessages,
  type GatheredResult,
  isPrivateObservation,
  OBSERVATION_TURN_MAX,
  renderActions,
  renderCarryover,
  renderContinuation,
  renderObservations,
  stableInput,
} from './carryover';

function results(count: number): GatheredResult[] {
  return Array.from({ length: count }, (_, index) => ({
    input: { query: `q${index}` },
    output: `result ${index}`,
    toolName: `tool${index}`,
  }));
}

describe('renderCarryover', () => {
  test('tells the next model not to re-run the tools', () => {
    // Without this line a fallback model repeats every web search the dead
    // attempt already paid for.
    expect(renderCarryover(results(2))).toContain(
      'do NOT re-run the same tools'
    );
  });

  test('includes each tool name, input and output', () => {
    const block = renderCarryover(results(2));
    expect(block).toContain('tool0');
    expect(block).toContain('q1');
    expect(block).toContain('result 1');
  });

  test('keeps the MOST RECENT results when over the cap', () => {
    // A turn that fell back deep into a long tool run must not hand the next
    // model the first twelve results and none of the recent ones.
    const block = renderCarryover(results(CARRYOVER_MAX_RESULTS + 5));
    expect(block).toContain(`tool${CARRYOVER_MAX_RESULTS + 4}`);
    expect(block).not.toContain('tool0(');
  });

  test('numbers the results from 1 after trimming', () => {
    const block = renderCarryover(results(CARRYOVER_MAX_RESULTS + 5));
    expect(block).toContain('1. tool5(');
  });

  test('clamps a huge tool output instead of blowing up the prompt', () => {
    const block = renderCarryover([
      { input: 'x', output: 'y'.repeat(50_000), toolName: 'searchWeb' },
    ]);
    expect(block.length).toBeLessThan(CARRYOVER_OUTPUT_MAX + 1000);
  });

  test('survives an unserializable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      renderCarryover([{ input: circular, output: 'ok', toolName: 't' }])
    ).not.toThrow();
  });
});

describe('renderContinuation', () => {
  const streamed = 'i checked the logs and found three errors.';

  test('quotes what the user was already shown', () => {
    expect(renderContinuation(streamed)).toContain(streamed);
  });

  test('says the turn is already in progress and must not restart', () => {
    // The whole point: without it the continuation model restates the answer
    // and the user reads it twice.
    const block = renderContinuation(streamed);
    expect(block).toContain('already in progress');
    expect(block).toContain('Do NOT repeat what was already said');
    expect(block).toContain('do not start the task over');
  });
});

describe('renderObservations', () => {
  test('is empty when the turn ran no tools', () => {
    expect(renderObservations([])).toBe('');
  });

  test('records what each tool was called with and returned', () => {
    const block = renderObservations(results(3));
    expect(block.split('\n\n')).toHaveLength(3);
    expect(block).toContain('tool1({"query":"q1"}) →\nresult 1');
  });

  test('keeps every call while the turn fits its cap', () => {
    expect(renderObservations(results(40)).split('\n\n')).toHaveLength(40);
  });

  test('keeps the most recent when over the turn cap, and says so', () => {
    const big = Array.from({ length: 20 }, (_, index) => ({
      input: { n: index },
      output: 'x'.repeat(5000),
      toolName: `tool${index}`,
    }));
    const block = renderObservations(big);
    expect(block.length).toBeLessThan(OBSERVATION_TURN_MAX + 6000);
    expect(block).toContain('tool19(');
    expect(block).not.toContain('tool0(');
    expect(block).toContain('earlier tool calls this turn not kept');
  });
});

describe('renderActions', () => {
  test('one short line per call', () => {
    const lines = renderActions([
      { input: { command: 'ls' }, output: 'a\nb', toolName: 'bash' },
      { input: { query: 'x' }, output: 'y'.repeat(900), toolName: 'searchWeb' },
    ]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('bash({"command":"ls"}) → a b');
    expect((lines[1] ?? '').length).toBeLessThan(400);
  });
});

describe('stableInput', () => {
  test('passes a string straight through', () => {
    expect(stableInput('hello')).toBe('hello');
  });

  test('serializes an object', () => {
    expect(stableInput({ a: 1 })).toBe('{"a":1}');
  });

  test('falls back to String() rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stableInput(circular)).toContain('object');
  });

  test('is stable — the same input dedupes to the same key', () => {
    // gatheredResults dedupes on `${toolName}:${stableInput(input)}`.
    expect(stableInput({ a: 1, b: 2 })).toBe(stableInput({ a: 1, b: 2 }));
  });
});

describe('isPrivateObservation', () => {
  const result = (toolName: string, output: unknown, input: unknown = {}) => ({
    input,
    output,
    toolName,
  });

  test('the open web is public', () => {
    expect(isPrivateObservation(result('searchWeb', 'D0123456789'))).toBe(
      false
    );
  });

  test('email, memory and MCP tools are private whatever they return', () => {
    expect(isPrivateObservation(result('email', 'nothing'))).toBe(true);
    expect(isPrivateObservation(result('memory', []))).toBe(true);
    expect(isPrivateObservation(result('mcp_linear_list', 'ok'))).toBe(true);
  });

  test('a read of a DM or private channel is private', () => {
    expect(
      isPrivateObservation(
        result('readConversationHistory', 'hi', { channel: 'D0BCA6D6GAV' })
      )
    ).toBe(true);
    expect(
      isPrivateObservation(result('getChannelInfo', { is_private: true }))
    ).toBe(true);
  });

  test('a public channel read and shouted words are not', () => {
    expect(
      isPrivateObservation(
        result('readConversationHistory', 'DEPRECATED GITHUBTOKEN', {
          channel: 'C0266FRGT',
        })
      )
    ).toBe(false);
  });
});

describe('renderObservations email redaction', () => {
  test('a stored email result never keeps a login link', () => {
    const link = 'https://example.com/reset-password?token=abcdefghijklmnop';
    for (const toolName of [
      'readEmail',
      'email',
      'mcp_agentmail_get_message',
    ]) {
      const rendered = renderObservations([
        { input: {}, output: `click ${link}`, toolName },
      ]);
      expect(rendered).not.toContain(link);
    }
    expect(
      renderObservations([
        { input: {}, output: `see ${link}`, toolName: 'fetchUrl' },
      ])
    ).toContain(link);
  });
});

describe('carriedMessages', () => {
  test('replays results as real calls, leaving out unknown tools', () => {
    const messages = carriedMessages({
      results: [
        { input: { q: 'x' }, output: { hits: 2 }, toolName: 'searchWeb' },
        { input: {}, output: 'text', toolName: 'madeUp' },
        { input: { command: 'ls' }, output: 'a.txt', toolName: 'bash' },
      ],
      toolNames: new Set(['bash', 'searchWeb']),
    });
    expect(messages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
    ]);
    expect(JSON.stringify(messages)).not.toContain('madeUp');
    expect(messages[1]).toMatchObject({
      content: [
        {
          output: { type: 'json', value: { hits: 2 } },
          toolCallId: 'carried-1',
        },
        { output: { type: 'text', value: 'a.txt' }, toolCallId: 'carried-2' },
      ],
    });
  });

  test('nothing carried, nothing sent', () => {
    expect(carriedMessages({ results: [], toolNames: new Set() })).toEqual([]);
  });

  test('bounds the carried results so a long attempt cannot blow up step 0', () => {
    // A 164-step attempt that fell back used to ship every result's full output
    // as one 901k-token request (2026-10-27). Keep the newest within budget.
    const big = Array.from({ length: 200 }, (_, index) => ({
      input: { n: index },
      output: 'x'.repeat(5000),
      toolName: 'bash',
    }));
    const messages = carriedMessages({
      results: big,
      toolNames: new Set(['bash']),
    });
    const [calls] = messages;
    const carried = Array.isArray(calls?.content) ? calls.content.length : 0;
    expect(carried).toBeLessThan(big.length);
    expect(JSON.stringify(messages).length).toBeLessThan(80_000);
    // Newest-first: the last result is kept, the first is dropped.
    expect(JSON.stringify(messages)).toContain('"n":199');
    expect(JSON.stringify(messages)).not.toContain('"n":0');
  });

  test('clamps a single oversized result instead of dropping everything', () => {
    const messages = carriedMessages({
      results: [{ input: {}, output: 'y'.repeat(50_000), toolName: 'bash' }],
      toolNames: new Set(['bash']),
    });
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain('clipped');
    expect(JSON.stringify(messages).length).toBeLessThan(20_000);
  });
});
