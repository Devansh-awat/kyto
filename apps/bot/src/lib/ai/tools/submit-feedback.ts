import { recordSubmittedFeedback } from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot } from '@/harness/bot';
import logger from '@/lib/logger';
import { redactSecrets } from '@/lib/redact';
import { errorMessage } from '@/lib/utils/error';

const MARKS = {
  bug: '🐞',
  other: '💬',
  praise: '🎉',
  suggestion: '💡',
} as const;
// Every piece is kept; the owner's DM is at most one per person in this window,
// so nobody can flood him through this tool.
const DM_INTERVAL_MS = 5 * 60 * 1000;
const lastDm = new Map<string, number>();

export function submitFeedbackTool({
  bot,
  threadId,
  userId,
}: {
  bot: KytoBot;
  threadId: string;
  userId: string;
}) {
  return tool({
    description:
      "Record feedback about kyto ITSELF that someone gives in conversation: a bug report, praise, a suggestion or a complaint about how kyto behaves, when there's no reply for them to click 👍/👎 under. It is saved and the owner is told. Put it in their words, with what happened; don't use it for feedback about anything other than kyto.",
    inputSchema: z.object({
      body: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The feedback, close to how they said it, plus what it is about.'
        ),
      kind: z.enum(['bug', 'praise', 'suggestion', 'other']),
    }),
    execute: async ({ body, kind }) => {
      const clean = redactSecrets(body.trim(), 'submitted feedback');
      await recordSubmittedFeedback({ body: clean, kind, threadId, userId });
      const recent = Date.now() - (lastDm.get(userId) ?? 0) < DM_INTERVAL_MS;
      if (env.OWNER_USER_ID && userId !== env.OWNER_USER_ID && !recent) {
        lastDm.set(userId, Date.now());
        try {
          const dm = await bot.openDM(env.OWNER_USER_ID);
          await dm.post({
            markdown: `${MARKS[kind]} *Feedback (${kind})* from <@${userId}> in \`${threadId}\`:\n${clean}`,
          });
        } catch (error) {
          logger.warn(
            { err: errorMessage(error), userId },
            '[feedback] could not DM the owner'
          );
        }
      }
      return {
        saved: true,
        summary: `Saved their ${kind} feedback and told the owner. Thank them in a few words; no need to repeat it back.`,
      };
    },
  });
}
