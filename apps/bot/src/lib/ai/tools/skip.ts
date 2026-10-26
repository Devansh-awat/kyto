import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';

/**
 * Calling this ENDS the attempt: `streamAttempt` stops on it, so the model is
 * never asked what to do next about a message it just declined. It has to stay
 * registered under `SKIP_TOOL_NAME` for that to hold — see the toolset.
 */
// A person's "@kyto respond" in a thread of banter with another bot was
// skipped because answering "would require mentioning a bot" (#145). Skipping a
// ping stays allowed (owner's call, 2026-10-26); that reason is what's wrong.
export function skipTool({ threadId }: { threadId: string }) {
  return tool({
    description:
      'End the turn without replying. Use when the message needs no response from you, for example when it is not addressed to you or is conversation between other people. Never after something you were asked to do was refused, denied or could not be done. Say what happened instead. Replying never requires mentioning anyone, a bot included: if an answer would involve another bot, answer without pinging it. That is never a reason to skip.',
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe('Optional short reason for skipping.'),
    }),
    execute: ({ reason }) => {
      logger.info({ reason, threadId }, '[agent] skipped reply');
      return { skipped: true };
    },
  });
}
