import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness';

// Slack user ids look like U0123ABCD / W0123ABCD. Validate loosely so the model
// can't accidentally pass a name where an id is required.
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,}$/;

export function focusModeTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      "Focus mode: restrict who you respond to in THIS thread. When focused on one or more users, you will only reply to (and only even see) messages from those users here — everyone else is ignored and their messages are hidden from your context, so other people can't distract or hijack you in a public thread. Use it when a user asks you to respond only to them (or a named set of people) in a thread. Call with `clear: true` to turn focus back off and respond to everyone again. The owner can always reach you regardless of focus.",
    inputSchema: z.object({
      clear: z
        .boolean()
        .optional()
        .describe('Set true to turn focus off and respond to everyone again.'),
      userIds: z
        .array(z.string())
        .optional()
        .describe(
          'Slack user ids (like U0123ABCD) to focus on. Take these from the `(U…)` id shown next to each sender. Ignored when clear is true.'
        ),
    }),
    execute: async ({ clear, userIds }) => {
      if (clear) {
        await thread.setFocus(null);
        return {
          focused: false,
          summary:
            'Focus mode off — I will respond to everyone in this thread again.',
        };
      }
      const ids = (userIds ?? []).filter((id) => SLACK_USER_ID.test(id));
      if (ids.length === 0) {
        return {
          error:
            'Provide at least one valid Slack user id (like U0123ABCD) to focus on, or pass clear: true to turn focus off.',
          success: false,
        };
      }
      const unique = [...new Set(ids)];
      await thread.setFocus(unique);
      return {
        focused: true,
        summary: `Focus mode on — I will only respond to and see messages from ${unique
          .map((id) => `<@${id}>`)
          .join(
            ', '
          )} in this thread. Others are ignored until focus is cleared.`,
        userIds: unique,
      };
    },
  });
}
