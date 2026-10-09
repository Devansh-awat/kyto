import type { RequestHints } from '@repo/ai';
import {
  getChannelInstructions,
  getUserCustomization,
  listGroupIdsForChannel,
  listMemoryCurations,
  listMemoryIndex,
} from '@repo/db/queries';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { slack } from '@/lib/chat';
import { resolveKytoEmail } from '@/lib/email/address';
import { resolveChannelName, resolveWorkspaceName } from '@/lib/slack/names';

// How long a tidy-up stays mentioned in the person's <memories> block.
const CURATION_NOTE_MS = 7 * 24 * 60 * 60 * 1000;

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
  const [
    channel,
    workspace,
    customization,
    memories,
    email,
    curations,
    channelInstructions,
  ] = await Promise.all([
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
    listMemoryCurations({
      author: message.author.userId,
      since: new Date(Date.now() - CURATION_NOTE_MS),
    }).catch(() => []),
    getChannelInstructions(channelId).catch(() => undefined),
  ]);
  const changes = curations.flatMap((pass) => pass.changes);
  return {
    botUserId: slack.botUserId,
    channel: {
      id: channelId,
      name: channel,
    },
    channelGroupIds: groupIds,
    channelInstructions: channelInstructions?.prompt,
    customization,
    email,
    memories,
    memoryCuration: {
      merged: changes
        .filter((change) => change.action === 'merge')
        .flatMap((change) => change.removed.map((memory) => memory.title)),
      removed: changes
        .filter((change) => change.action === 'remove')
        .flatMap((change) => change.removed.map((memory) => memory.title)),
    },
    ownerUserId: env.OWNER_USER_ID,
    githubLogin: env.GH_LOGIN,
    workspace,
    threadId: thread.id,
  };
}
