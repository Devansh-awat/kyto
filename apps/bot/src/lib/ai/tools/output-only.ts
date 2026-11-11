import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';

/**
 * The person asked for exactly the output and nothing else ("nothing else",
 * "only the list", "no explanation"). Calling this first strips everything kyto
 * adds around a reply: the thinking and tool cards, the "done in Xs" line and
 * the feedback buttons (#218). A note that a weaker model answered stays, since
 * it is about the answer's quality.
 */
export function outputOnlyTool({
  onOutputOnly,
  threadId,
}: {
  onOutputOnly: () => void;
  threadId: string;
}) {
  return tool({
    description:
      'Call this FIRST, before any text, when the person asked for exactly the output and nothing else: "nothing else", "only X", "just the list", "no explanation", "exactly this". Nothing but your reply is then shown: no thinking or tool cards, no timing line, no feedback buttons. Then write only the requested output, with no intro or sign-off. Do not call it for an ordinary short answer.',
    inputSchema: z.object({}),
    execute: () => {
      onOutputOnly();
      logger.info({ threadId }, '[agent] output only requested');
      return { ok: true };
    },
  });
}
