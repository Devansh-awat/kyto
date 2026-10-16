import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import { setTodos } from '@/lib/todo-list';

const MAX_ITEMS = 30;
const MAX_ITEM_CHARS = 200;

export function todoTool({ thread }: { thread: ThreadHandle }) {
  return tool({
    description:
      'Your to-do list for a long, multi-part task, shown LIVE to the people in the thread as a checklist kept at the bottom of it. Use it when a request has 3 or more distinct steps, or several asks in one message; skip it for anything quick. Send the WHOLE list on every call (it replaces the last one). Keep exactly one item `in_progress` while you work, mark each `done` the moment it is (not all at the end), and add items you discover on the way. A list you leave unfinished is handed back to you on your next turn in this thread; a finished one disappears when your reply is done.',
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            status: z.enum(['pending', 'in_progress', 'done']),
            text: z
              .string()
              .min(1)
              .max(MAX_ITEM_CHARS)
              .describe('What this step is, in a few words.'),
          })
        )
        .min(1)
        .max(MAX_ITEMS),
    }),
    execute: async ({ items }) => {
      await setTodos({ items, thread });
      const done = items.filter((item) => item.status === 'done').length;
      return {
        success: true,
        summary: `To-do list shown: ${done}/${items.length} done.`,
      };
    },
  });
}
