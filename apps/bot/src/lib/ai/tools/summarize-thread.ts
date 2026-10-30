import { drawnAttempts, streamAttempt } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import type { KytoBot as Chat } from '@/harness/bot';
import { slack } from '@/lib/chat';
import { assertReadableChannel, joinChannel } from './utils';

export function summarizeThreadTool({
  askerUserId,
  bot,
  threadId,
}: {
  askerUserId: string;
  bot: Chat;
  threadId: string;
}) {
  return tool({
    description:
      'Summarize a Slack thread: its decisions, open questions and action items. Leave out threadId for the current thread; pass one (`slack:C…:ts`) for another thread the asker can read.',
    inputSchema: z.object({
      instructions: z
        .string()
        .optional()
        .describe('Optional focus or format instructions for the summary.'),
      threadId: z.string().optional(),
    }),
    execute: async (input) => {
      const targetThreadId = input.threadId ?? threadId;
      const channelId = slack.channelIdFromThreadId(targetThreadId);
      await assertReadableChannel(channelId, {
        askerUserId,
        currentThreadId: threadId,
      });
      await joinChannel({ askerUserId, channelId });
      const result = await bot
        .thread(targetThreadId)
        .adapter.fetchMessages(targetThreadId, {
          direction: 'backward',
          limit: 100,
        });
      if (result.messages.length === 0) {
        return { error: 'No messages found in the thread.', success: false };
      }

      const transcript = result.messages
        .map((message) => {
          const author = message.author.fullName || message.author.userName;
          return `${author}: ${message.text}`;
        })
        .join('\n');
      // Haiku or luna at random like every non-turn call (owner's call
      // 2026-10-17), Gemini behind them.
      let text = '';
      for (const attempt of drawnAttempts()) {
        try {
          const result = streamAttempt({
            attempt,
            holder: {},
            prompt: `${input.instructions ? `${input.instructions}\n\n` : ''}Summarize this thread clearly and concisely. Preserve decisions, open questions, and action items when present.\n\n${transcript}`,
            source: 'summarize-thread',
            system: 'You summarize Slack threads accurately and concisely.',
            tools: {},
          });
          text = (await result.text).trim();
        } catch {
          // The next model.
        }
        if (text) {
          break;
        }
      }
      if (!text) {
        return { error: 'The summary could not be written.', success: false };
      }
      return {
        messageCount: result.messages.length,
        success: true,
        actionSummary: `Summarized ${result.messages.length} message${result.messages.length === 1 ? '' : 's'} from ${targetThreadId}.`,
        summary: text,
      };
    },
  });
}
