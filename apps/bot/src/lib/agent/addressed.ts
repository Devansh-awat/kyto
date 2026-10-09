import { z } from 'zod';
import { env } from '@/env';
import type { Message } from '@/harness/types';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// Whether a message that lands while kyto is mid-turn is meant for kyto at all
// (owner's ask, issue #27). Every human message in a followed thread used to
// interrupt the running turn, so in a busy thread a line aimed at another bot
// cut off kyto's answer to a real @mention — and the follow-up turn then
// skipped, because the newest message was not for kyto. Jev is asked only for a
// message that does not ping kyto; a ping or a DM always interrupts.

const JEV_URL = 'https://ai.hackclub.com/proxy/v1/jev/systemone';
const JEV_TIMEOUT_MS = 3000;
// Low on purpose: a wrong "no" leaves a message for kyto with no turn at all,
// a wrong "yes" is only the old behaviour (the running turn restarts).
const ADDRESSED_THRESHOLD = 0.3;
const MAX_STATE_CHARS = 6000;
const MENTION = /<@([A-Z0-9]+)>/g;

const responseSchema = z.object({
  answers: z.object({
    addressed: z.object({ noul: z.number().min(0).max(1) }),
  }),
});

/** The running turn's message, anything queued behind it, then the new one. */
export function addressedState({
  messages,
  selfId,
}: {
  messages: Message[];
  selfId: string | undefined;
}): string {
  return messages
    .map(({ author, text }) => {
      const body = text.replace(MENTION, (_, id: string) =>
        id === selfId ? '@kyto' : `@${id}`
      );
      return `${author.fullName ?? author.userName}${author.isBot ? ' (bot)' : ''}: ${body.trim()}`;
    })
    .join('\n')
    .slice(-MAX_STATE_CHARS);
}

/** True unless Jev is fairly sure the latest message is not for kyto; fails OPEN. */
export async function isAddressedToKyto(state: string): Promise<boolean> {
  try {
    const response = await fetch(JEV_URL, {
      body: JSON.stringify({
        questions: {
          addressed: {
            instructions:
              'kyto is an AI assistant in this Slack thread, which other people and bots also talk in. kyto is busy answering an earlier message. Is the LATEST message meant for kyto — addressed to it, a follow-up or correction to what kyto is working on, or something kyto is expected to respond to — rather than meant only for another person or bot?',
            type: 'noul',
          },
        },
        state,
      }),
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        '[addressed] jev refused; interrupting'
      );
      return true;
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return true;
    }
    const probability = parsed.data.answers.addressed.noul;
    logger.info({ probability }, '[addressed] jev scored the new message');
    return probability >= ADDRESSED_THRESHOLD;
  } catch (error) {
    logger.warn(toLogError(error), '[addressed] jev call failed; interrupting');
    return true;
  }
}
