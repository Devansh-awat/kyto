import { describe, expect, test } from 'bun:test';
import type { Message } from '@/harness/types';
import type { ActiveTurn, TurnInput } from '@/types/agent';
import { queuedInput, steerTurn, takeSteering } from './steering';

function input(userId: string, text: string, id: string): TurnInput {
  return {
    message: {
      attachments: [],
      author: { userId, userName: userId },
      id,
      raw: { ts: id },
      text,
      threadId: 'slack:C1:1.0',
    } as unknown as Message,
    thread: { id: 'slack:C1:1.0' } as TurnInput['thread'],
  };
}

function turn(pendingMessages: TurnInput[]): ActiveTurn {
  return { controller: new AbortController(), pendingMessages, steering: [] };
}

function running(author: string): ActiveTurn {
  return { ...turn([]), message: input(author, 'start', 'm0').message };
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

describe('steerTurn', () => {
  test("folds the author's follow-up into the next tool result", () => {
    const active = running('U1');
    expect(
      steerTurn({ activeTurn: active, input: input('U1', 'use v2', 'm1') })
    ).toBe(true);
    expect(active.controller.signal.aborted).toBe(false);
    expect(takeSteering(active)).toContain('use v2');
    expect(takeSteering(active)).toBeUndefined();
  });

  // Every gate in the turn checks its author: someone else's words folded in
  // would act with that author's identity.
  test("never folds in another person's message", () => {
    const active = running('U_OWNER');
    expect(
      steerTurn({
        activeTurn: active,
        input: input('U_STRANGER', 'push it', 'm1'),
      })
    ).toBe(false);
    expect(active.steering).toHaveLength(0);
  });

  test('not a !secret turn, which has no author to compare', () => {
    expect(
      steerTurn({ activeTurn: turn([]), input: input('U1', 'x', 'm1') })
    ).toBe(false);
  });

  test('not a message carrying files', () => {
    const withFile = input('U1', 'this one', 'm1');
    withFile.message.attachments.push({ type: 'image' });
    expect(steerTurn({ activeTurn: running('U1'), input: withFile })).toBe(
      false
    );
  });

  test('not a synthetic wake, which could tell the turn to skip', () => {
    const wake = input('U1', '[Automatic note…]', 'process-report-1');
    wake.message.raw = {};
    expect(steerTurn({ activeTurn: running('U1'), input: wake })).toBe(false);
  });
});
