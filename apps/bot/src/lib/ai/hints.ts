import type { RequestHints } from '@repo/ai';
import { getUserCustomization, listMemoryIndex } from '@repo/db/queries';
import { env } from '@/env';
import type { Message, ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import { resolveChannelName, resolveWorkspaceName } from '@/lib/slack/names';

export async function requestHints({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<RequestHints> {
  const channelId = slack.channelIdFromThreadId(thread.id);
  const { channel: rawChannelId } = slack.decodeThreadId(thread.id);
  const [channel, workspace, customization, memories] = await Promise.all([
    resolveChannelName(rawChannelId),
    resolveWorkspaceName(),
    getUserCustomization(message.author.userId).catch(() => null),
    listMemoryIndex().catch(() => []),
  ]);
  return {
    botUserId: slack.botUserId,
    channel: {
      id: channelId,
      name: channel,
    },
    customization,
    memories,
    messageId: message.id,
    ownerUserId: env.OWNER_USER_ID,
    workspace,
    threadId: thread.id,
    time: new Date().toISOString(),
  };
}
