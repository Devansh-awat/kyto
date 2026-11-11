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
      'End the turn without replying. Use when the message needs nothing from you: it is not addressed to you, it is conversation between other people, or it is a bare "ok"/"lol"/"thanks" with nothing to add. Never skip when you are pinged, in a DM, or the message follows up on your own answer and adds something, or comes from the person who just got your answer (channel tags, a link, a file, a mention, "what?"): those are asking you to do something, so do it. Never skip a message that uses your name or asks a question right after your own reply or upload, even a terse one: treat "X?" as a request to do or show X. Never after something you were asked to do was refused, denied or could not be done. Say what happened instead. Replying never requires mentioning anyone, a bot included: if an answer would involve another bot, answer without pinging it. That is never a reason to skip.',
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
