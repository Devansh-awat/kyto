import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { applyTrim, estimateMessageTokens, planTrim } from './context-trim';

const history: ModelMessage = { content: 'x'.repeat(30_000), role: 'user' };

const result = (id: string, chars: number): ModelMessage => ({
  content: [
    {
      output: { type: 'text', value: 'r'.repeat(chars) },
      toolCallId: id,
      toolName: 'bash',
      type: 'tool-result',
    },
  ],
  role: 'tool',
});

function outputOf(message: ModelMessage | undefined): string {
  if (!(message && Array.isArray(message.content))) {
    return '';
  }
  const part = message.content[0];
  return part?.type === 'tool-result' && part.output.type === 'text'
    ? part.output.value
    : '';
}

function trim(messages: ModelMessage[], target: number, summary?: string) {
  const plan = planTrim({
    fromIndex: 1,
    messages,
    target,
    tokens: estimateMessageTokens(messages),
  });
  return {
    ...plan,
    messages: applyTrim({ messages, picks: plan.picks, summary }),
  };
}

describe('planTrim / applyTrim', () => {
  test('returns the same array when already under target', () => {
    const messages = [history, result('a', 9000)];
    const out = trim(messages, 100_000);
    expect(out.picks).toHaveLength(0);
    expect(out.messages).toBe(messages);
  });

  test('folds oldest results first and stops at the target', () => {
    const messages = [
      history,
      result('a', 30_000),
      result('b', 30_000),
      result('c', 30_000),
    ];
    const out = trim(messages, 25_000);
    expect(out.picks.map((pick) => pick.toolCallId)).toEqual(['a', 'b']);
    expect(outputOf(out.messages[1])).toStartWith('[Trimmed:');
    expect(outputOf(out.messages[2])).toStartWith('[Trimmed:');
    expect(out.messages[3]).toBe(messages[3]);
    expect(out.messages[0]).toBe(history);
  });

  test('a summary goes on the first folded result, the rest point at it', () => {
    const messages = [history, result('a', 30_000), result('b', 30_000)];
    const out = trim(messages, 0, 'SUMMARY');
    expect(outputOf(out.messages[1])).toEndWith('SUMMARY');
    expect(outputOf(out.messages[2])).toContain('compacted into the summary');
  });

  test('leaves small and already-folded results alone, so a re-run is stable', () => {
    const messages = [history, result('a', 30_000), result('b', 500)];
    const first = trim(messages, 0);
    expect(first.picks).toHaveLength(1);
    expect(first.messages[2]).toBe(messages[2]);
    const second = trim(first.messages, 0);
    expect(second.picks).toHaveLength(0);
    expect(second.messages).toBe(first.messages);
  });
});
