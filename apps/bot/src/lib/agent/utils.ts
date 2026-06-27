import type { Thread } from 'chat';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const loadingMessages = [
  'is reading the room',
  'is checking the thread',
  'is sorting context',
  'is warming up the sandbox',
  'is lining things up',
  'is thinking suspiciously hard',
  'is flexing on Gorkie',
  'is consulting its own genius',
  'is doing what Coolton never could',
  'is being the best agent in the world',
  'is pretending the other bots exist',
  'is overthinking this on purpose',
  'is rolling its eyes at the question',
  'is summoning bravado',
  'is loading 200% confidence',
  'is checking if anyone can match it (nope)',
  'is sharpening a comeback',
  'is winning, as usual',
  'is cooking something up',
  'is taking a nap',
  'is stretching its circuits',
  'is pretending to read the docs',
  'is googling itself',
  'is brewing a hot take',
  'is untangling its thoughts',
  'is buffering on purpose',
  'is procrastinating productively',
  'is dramatically pausing',
  'is consulting the vibes',
];

export async function startThinking({
  thread,
}: {
  thread: Thread;
}): Promise<void> {
  const { channel, threadTs } = slack.decodeThreadId(thread.id);
  if (!threadTs) {
    await thread.startTyping('is thinking');
    return;
  }

  await slack
    .setAssistantStatus(channel, threadTs, 'is thinking', loadingMessages)
    .catch((error: unknown) => {
      logger.warn(
        { err: errorMessage(error), threadId: thread.id },
        '[agent] failed to set thinking status'
      );
    });
}
