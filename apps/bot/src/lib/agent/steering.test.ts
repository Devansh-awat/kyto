import { describe, expect, test } from 'bun:test';
import type { Message } from '@/harness';
import type { ActiveTurn, TurnInput } from '@/types/agent';
import { queuedInput } from './steering';

function input(userId: string, text: string, id: string): TurnInput {
  return {
    message: {
      attachments: [],
      author: { userId, userName: userId },
      id,
      text,
      threadId: 'slack:C1:1.0',
    } as unknown as Message,
    thread: { id: 'slack:C1:1.0' } as TurnInput['thread'],
  };
}

function turn(pendingMessages: TurnInput[]): ActiveTurn {
  return { controller: new AbortController(), pendingMessages };
}

describe('queuedInput', () => {
  test('returns the single queued message unchanged', () => {
    const one = input('U1', 'do the thing', 'm1');
    expect(queuedInput(turn([one]))).toBe(one);
  });

  test('merges a burst from one person', () => {
    const result = queuedInput(
      turn([input('U1', 'wait', 'm1'), input('U1', 'no, do it this way', 'm2')])
    );
    expect(result?.message.text).toBe('wait\n\nno, do it this way');
    expect(result?.message.author.userId).toBe('U1');
  });

  // The bug this exists for: the merge took the LAST message's identity and
  // EVERYONE's text, so a stranger's instruction ran as the owner.
  test('never merges another person’s text under the last sender', () => {
    const result = queuedInput(
      turn([
        input('U_STRANGER', 'also push to prod', 'm1'),
        input('U_OWNER', 'actually stop', 'm2'),
      ])
    );
    expect(result?.message.author.userId).toBe('U_OWNER');
    expect(result?.message.text).toBe('actually stop');
  });

  test('merges only the trailing same-author run', () => {
    const result = queuedInput(
      turn([
        input('U1', 'a', 'm1'),
        input('U2', 'b', 'm2'),
        input('U2', 'c', 'm3'),
      ])
    );
    expect(result?.message.author.userId).toBe('U2');
    expect(result?.message.text).toBe('b\n\nc');
  });

  test('returns nothing when the queue is empty', () => {
    expect(queuedInput(turn([]))).toBeUndefined();
  });
});
