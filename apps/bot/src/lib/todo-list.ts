import type { ThreadHandle } from '@/harness/thread';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// kyto's to-do list for a long multi-part task (the `todo` tool), shown LIVE
// as one message kept at the BOTTOM of the thread (owner's ask 2026-10-16):
// while the turn runs, any newer message in the thread (a person's, kyto's own
// next reply message) gets the list deleted and posted again under it. When
// the turn ends, a finished list is deleted (the reply covers it) and an
// unfinished one stays where it is and is handed to the next turn. In memory:
// a restart's resumed turn writes its list again.

type TodoStatus = 'done' | 'in_progress' | 'pending';

export interface TodoItem {
  status: TodoStatus;
  text: string;
}

interface TodoList {
  items: TodoItem[];
  /** Kept at the bottom: only while a turn is working from it. */
  live: boolean;
  /** A move to the bottom waiting out its debounce. */
  moving?: ReturnType<typeof setTimeout>;
  /** Every Slack call for this list, one after another. */
  queue: Promise<void>;
  thread: ThreadHandle;
  /** The posted message. */
  ts?: string;
  updatedAt: number;
}

// Several messages land together (a reply's text and its cards, a burst from
// a person): one move after they settle, not one per message.
const MOVE_DEBOUNCE_MS = 1500;
const KEEP_MS = 24 * 60 * 60 * 1000;
// Slack's own plan block (the look of kyto's Thinking cards: a check, a
// spinner, an empty circle), which a plain post accepts too (checked
// 2026-10-17 with 30 items of 200 chars). It replaced emoji lines the owner
// found ugly.
const PLAN_STATUS: Record<TodoStatus, string> = {
  done: 'complete',
  in_progress: 'in_progress',
  pending: 'pending',
};

const lists = new Map<string, TodoList>();

function render(items: TodoItem[]): {
  blocks: unknown[];
  fallbackText: string;
} {
  const done = items.filter((item) => item.status === 'done').length;
  const title = `To-do · ${done}/${items.length}`;
  const current = items.find((item) => item.status === 'in_progress');
  return {
    blocks: [
      {
        tasks: items.map(({ status, text }, index) => ({
          status: PLAN_STATUS[status],
          task_id: `todo-${index}`,
          title: text.replaceAll('\n', ' '),
        })),
        title,
        type: 'plan',
      },
    ],
    fallbackText: current ? `${title}: ${current.text}` : title,
  };
}

function enqueue(list: TodoList, step: () => Promise<void>): Promise<void> {
  list.queue = list.queue.then(step).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), threadId: list.thread.id },
      '[todo] slack call failed'
    );
  });
  return list.queue;
}

async function repost(list: TodoList): Promise<void> {
  const old = list.ts;
  list.ts = undefined;
  if (old) {
    await list.thread.adapter.webClient.chat
      .delete({
        channel: list.thread.adapter.decodeThreadId(list.thread.id).channel,
        ts: old,
      })
      .catch(() => undefined);
  }
  const sent = await list.thread.post(render(list.items));
  list.ts = sent.id || undefined;
}

/** The `todo` tool: replace the list and show it. */
export async function setTodos({
  items,
  thread,
}: {
  items: TodoItem[];
  thread: ThreadHandle;
}): Promise<void> {
  const existing = lists.get(thread.id);
  // An earlier turn's list sits mid-thread by now: post it fresh at the end.
  const wasLive = existing?.live === true;
  const list: TodoList = existing ?? {
    items,
    live: true,
    queue: Promise.resolve(),
    thread,
    updatedAt: Date.now(),
  };
  list.items = items;
  list.live = true;
  list.thread = thread;
  list.updatedAt = Date.now();
  lists.set(thread.id, list);
  await enqueue(list, async () => {
    // Edited in place while it is still the newest message: a repost on every
    // tick would ping the thread each time.
    if (list.ts && wasLive && !list.moving) {
      await list.thread.update(list.ts, render(list.items));
      return;
    }
    await repost(list);
  });
}

/** Move a live list under whatever was just posted. */
export function moveTodosDown(threadId: string): void {
  const list = lists.get(threadId);
  if (!(list?.live && list.ts)) {
    return;
  }
  clearTimeout(list.moving);
  list.moving = setTimeout(() => {
    list.moving = undefined;
    if (list.live) {
      enqueue(list, () => repost(list)).catch(() => undefined);
    }
  }, MOVE_DEBOUNCE_MS);
  list.moving.unref?.();
}

/**
 * A message event: anything newer than the list in its thread moves the list
 * under it. Edits, deletions and the list's own post don't.
 */
export function onThreadMessage(event: Record<string, unknown>): void {
  const { channel, subtype, thread_ts: threadTs, ts } = event;
  if (
    typeof channel !== 'string' ||
    typeof ts !== 'string' ||
    subtype === 'message_changed' ||
    subtype === 'message_deleted' ||
    subtype === 'message_replied'
  ) {
    return;
  }
  // A thread reply, or a top-level message in a channel that is one
  // conversation (a native code channel).
  const threadId =
    typeof threadTs === 'string' && threadTs !== ts
      ? `slack:${channel}:${threadTs}`
      : `slack:${channel}`;
  const list = lists.get(threadId);
  if (list?.ts && Number(ts) > Number(list.ts)) {
    moveTodosDown(threadId);
  }
}

/**
 * The turn is over. A finished list is deleted (the reply says what was done);
 * an unfinished one stays put, no longer kept at the bottom, for the next turn
 * to pick up. After a shutdown it is deleted: the resumed turn writes it again.
 */
export async function endTodoTurn({
  shutdown,
  threadId,
}: {
  shutdown: boolean;
  threadId: string;
}): Promise<void> {
  const list = lists.get(threadId);
  if (!list?.live) {
    return;
  }
  list.live = false;
  clearTimeout(list.moving);
  list.moving = undefined;
  const finished = list.items.every((item) => item.status === 'done');
  if (!(finished || shutdown)) {
    return;
  }
  lists.delete(threadId);
  await enqueue(list, async () => {
    if (list.ts) {
      await list.thread.adapter.webClient.chat.delete({
        channel: list.thread.adapter.decodeThreadId(threadId).channel,
        ts: list.ts,
      });
    }
  });
}

/** An unfinished list an earlier turn left, for this turn's prompt. */
export function leftoverTodos(threadId: string): TodoItem[] | undefined {
  const list = lists.get(threadId);
  if (!list || list.live) {
    return;
  }
  if (Date.now() - list.updatedAt > KEEP_MS) {
    lists.delete(threadId);
    return;
  }
  return list.items;
}
