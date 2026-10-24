import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';

/**
 * Calling this ENDS the attempt: `streamAttempt` stops on it, so the model is
 * never asked what to do next about a message it just declined. It has to stay
 * registered under `SKIP_TOOL_NAME` for that to hold — see the toolset.
 */
export function skipTool({
  threadId,
  mentionedByHuman,
}: {
  threadId: string;
  /** This turn's own message is a real @mention of kyto from a human. */
  mentionedByHuman: boolean;
}) {
  return tool({
    description:
      'End the turn without replying. Use when the message needs no response from you, for example when it is not addressed to you or is conversation between other people. Never after something you were asked to do was refused, denied or could not be done. Say what happened instead.',
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe('Optional short reason for skipping.'),
    }),
    execute: ({ reason }) => {
      // A human @mentioned kyto directly: that is addressed TO kyto, whatever
      // the surrounding banter looks like. Reading "respond" as talking to a
      // bot and skipping it (#145) is wrong — reply with one short line.
      if (mentionedByHuman) {
        logger.info(
          { reason, threadId },
          '[agent] skip refused — direct human mention'
        );
        return {
          skipped: false,
          error:
            'A human @mentioned you directly, so this is addressed to you. Do not skip — reply with one short line.',
        };
      }
      logger.info({ reason, threadId }, '[agent] skipped reply');
      return { skipped: true };
    },
  });
}
