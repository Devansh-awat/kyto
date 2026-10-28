import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { replayableContext } from './sent-context';

const request: ModelMessage = { content: 'new request', role: 'user' };
const call = (name: string, id: string): ModelMessage => ({
  content: [{ input: {}, toolCallId: id, toolName: name, type: 'tool-call' }],
  role: 'assistant',
});
const result = (name: string, id: string): ModelMessage => ({
  content: [
    {
      output: { type: 'text', value: 'out' },
      toolCallId: id,
      toolName: name,
      type: 'tool-result',
    },
  ],
  role: 'tool',
});

describe('replayableContext', () => {
  test('keeps every message, swapping in the new request', () => {
    const out = replayableContext({
      context: {
        inputTokens: 1000,
        measuredLength: 3,
        messages: [
          { content: 'summary', role: 'user' },
          { content: 'old request', role: 'user' },
          call('bash', 'a'),
          result('bash', 'a'),
        ],
        requestIndex: 1,
      },
      request,
      toolNames: new Set(['bash']),
    });
    expect(out.messages).toHaveLength(4);
    expect(out.messages[1]).toBe(request);
    expect(out.requestIndex).toBe(1);
    expect(out.unmeasuredFrom).toBe(3);
    expect(JSON.stringify(out.messages[2])).toContain('carried-a');
  });

  test("drops a call to a tool this attempt doesn't have, with its result", () => {
    const out = replayableContext({
      context: {
        measuredLength: 0,
        messages: [
          { content: 'old request', role: 'user' },
          call('gone', 'x'),
          result('gone', 'x'),
          call('bash', 'b'),
          result('bash', 'b'),
        ],
        requestIndex: 0,
      },
      request,
      toolNames: new Set(['bash']),
    });
    expect(out.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(JSON.stringify(out.messages)).not.toContain('gone');
  });

  test('a context without its request gets it after the summary', () => {
    const out = replayableContext({
      context: {
        measuredLength: 0,
        messages: [{ content: 'summary', role: 'user' }],
        requestIndex: -1,
      },
      request,
      toolNames: new Set(),
    });
    expect(out.messages[1]).toBe(request);
    expect(out.requestIndex).toBe(1);
  });
});
