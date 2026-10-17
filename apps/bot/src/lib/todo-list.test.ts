import { describe, expect, test } from 'bun:test';
import type { ThreadHandle } from '@/harness/thread';
import {
  endTodoTurn,
  leftoverTodos,
  onThreadMessage,
  setTodos,
} from './todo-list';

// A thread that records what the list did to Slack.
function fakeThread(id: string) {
  const calls: string[] = [];
  let next = 100;
  const thread = {
    adapter: {
      decodeThreadId: () => ({ channel: 'C1', threadTs: '1.0' }),
      webClient: {
        chat: {
          delete: ({ ts }: { ts: string }) => {
            calls.push(`delete ${ts}`);
            return Promise.resolve();
          },
        },
      },
    },
    id,
    post: ({ fallbackText }: { fallbackText: string }) => {
      next += 1;
      calls.push(`post ${next} ${fallbackText}`);
      return Promise.resolve({ id: `${next}.0` });
    },
    update: (ts: string) => {
      calls.push(`update ${ts}`);
      return Promise.resolve();
    },
  } as unknown as ThreadHandle;
  return { calls, thread };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('to-do list', () => {
  test('edits in place, moves under a newer message, and goes when done', async () => {
    const { calls, thread } = fakeThread('slack:C1:1.0');
    await setTodos({
      items: [
        { status: 'in_progress', text: 'a' },
        { status: 'pending', text: 'b' },
      ],
      thread,
    });
    await setTodos({
      items: [
        { status: 'done', text: 'a' },
        { status: 'in_progress', text: 'b' },
      ],
      thread,
    });
    // Its own post and older messages don't move it; a newer one does, once
    // for a burst.
    onThreadMessage({ channel: 'C1', thread_ts: '1.0', ts: '101.0' });
    onThreadMessage({ channel: 'C1', thread_ts: '1.0', ts: '50.0' });
    onThreadMessage({ channel: 'C1', thread_ts: '1.0', ts: '200.0' });
    onThreadMessage({ channel: 'C1', thread_ts: '1.0', ts: '201.0' });
    await wait(1700);
    await endTodoTurn({ shutdown: false, threadId: 'slack:C1:1.0' });
    expect(calls).toEqual([
      'post 101 To-do · 0/2: a',
      'update 101.0',
      'delete 101.0',
      'post 102 To-do · 1/2: b',
    ]);
    // Unfinished: it stays for the next turn.
    expect(leftoverTodos('slack:C1:1.0')).toHaveLength(2);
  });

  test('a finished list is deleted at the end of the turn', async () => {
    const { calls, thread } = fakeThread('slack:C1:2.0');
    await setTodos({ items: [{ status: 'done', text: 'a' }], thread });
    await endTodoTurn({ shutdown: false, threadId: 'slack:C1:2.0' });
    expect(calls).toEqual(['post 101 To-do · 1/1', 'delete 101.0']);
    expect(leftoverTodos('slack:C1:2.0')).toBeUndefined();
  });
});
