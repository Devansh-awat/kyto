import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot as Chat } from '@/harness/bot';
import { errorMessage } from '@/lib/utils/error';

// A bare `invalid_name` left the model retrying blind with more invented names.
function reactionError(error: unknown, emoji: string): string {
  const message = errorMessage(error);
  return message.includes('invalid_name')
    ? `There is no emoji named "${emoji}" here. Use a standard name (+1, heart, eyes, white_check_mark) or find a workspace emoji with lookupEmoji (a partial name lists matches).`
    : message;
}

export function reactTool({ bot }: { bot: Chat }) {
  return tool({
    description: 'Add an emoji reaction to a specific message.',
    inputSchema: z.object({
      threadId: z.string(),
      messageId: z.string(),
      emoji: z.string().describe('Emoji name without colons, e.g. +1 or eyes.'),
    }),
    execute: async ({ emoji, messageId, threadId }) => {
      const thread = bot.thread(threadId);
      try {
        await thread.adapter.addReaction(threadId, messageId, emoji);
      } catch (error) {
        return { added: false, error: reactionError(error, emoji) };
      }
      return { added: true, emoji, messageId, threadId };
    },
  });
}

export function unreactTool({ bot }: { bot: Chat }) {
  return tool({
    description: 'Remove an emoji reaction from a specific message.',
    inputSchema: z.object({
      emoji: z.string().describe('Emoji name without colons, e.g. +1 or eyes.'),
      messageId: z.string(),
      threadId: z.string(),
    }),
    execute: async ({ emoji, messageId, threadId }) => {
      const thread = bot.thread(threadId);
      try {
        await thread.adapter.removeReaction(threadId, messageId, emoji);
      } catch (error) {
        return { error: reactionError(error, emoji), removed: false };
      }
      return { emoji, messageId, removed: true, threadId };
    },
  });
}
