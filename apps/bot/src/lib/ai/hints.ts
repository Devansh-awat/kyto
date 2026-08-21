import type { RequestHints } from '@repo/ai';
import {
  getUserCustomization,
  listGroupIdsForChannel,
  listMemoryIndex,
} from '@repo/db/queries';
import { env } from '@/env';
import type { Message, ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import { resolveKytoEmail } from '@/lib/email/address';
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
  const groupIds = await listGroupIdsForChannel(channelId).catch(() => []);
  const [channel, workspace, customization, memories, email] =
    await Promise.all([
      resolveChannelName(rawChannelId),
      resolveWorkspaceName(),
      getUserCustomization(message.author.userId).catch(() => null),
      // Scoped to the person kyto is answering: their own memories, whatever the
      // owner has promoted to global, and whatever the owner has promoted into
      // THIS channel (or a group it belongs to). Someone else's private notes
      // are never in this list, so they can't become instructions on a
      // stranger's turn — every wider branch needs a promotion the owner made.
      listMemoryIndex(message.author.userId, { channelId, groupIds }).catch(
        () => []
      ),
      // Cached after the first resolve — no per-turn AgentMail call.
      resolveKytoEmail().catch(() => undefined),
    ]);
  return {
    botUserId: slack.botUserId,
    channel: {
      id: channelId,
      name: channel,
    },
    channelGroupIds: groupIds,
    customization,
    email,
    memories,
    ownerUserId: env.OWNER_USER_ID,
    githubLogin: env.GH_LOGIN,
    workspace,
    threadId: thread.id,
  };
}
