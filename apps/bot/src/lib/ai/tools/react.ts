import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot as Chat } from '@/harness';

export function reactTool({ bot }: { bot: Chat }) {
  return tool({
    description: 'Add an emoji reaction to a specific message.',
    inputSchema: z.object({
      threadId: z.string(),
      messageId: z.string(),
      emoji: z.string(),
    }),
    execute: async ({ emoji, messageId, threadId }) => {
      const thread = bot.thread(threadId);
      await thread.adapter.addReaction(threadId, messageId, emoji);
      return { added: true, emoji, messageId, threadId };
    },
  });
}
