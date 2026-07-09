import { tool } from 'ai';
import { z } from 'zod';
import {
  type KytoBot as Chat,
  neutralizeBroadcast,
  type PostContent,
} from '@/harness';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import { toRawSlackChannelId } from '@/lib/slack/ids';

// Cross-channel posting is gated: only the OWNER can make Kyto post outside the
// channel it was invoked in. For everyone else Kyto may only post back into the
// SAME channel/thread it was mentioned in — a workspace-admin requirement, so a
// non-owner can't tell it (from a thread in #general) to post into
// #announcements or DM a stranger.
function rawChannelOf(threadIdOrChannel: string): string {
  return toRawSlackChannelId(
    threadIdOrChannel.startsWith('slack:')
      ? slack.channelIdFromThreadId(threadIdOrChannel)
      : threadIdOrChannel
  );
}

export function postMessageTool({
  bot,
  currentThreadId,
  isOwner,
}: {
  bot: Chat;
  currentThreadId: string;
  isOwner: boolean;
}) {
  const currentChannel = rawChannelOf(currentThreadId);
  return tool({
    description: isOwner
      ? 'Post a markdown-formatted message to another target. Type must be thread, channel, or user.'
      : 'Post a markdown-formatted message. You may ONLY post into the current channel/thread (type thread or channel, the same channel you were mentioned in) — posting to a different channel or DMing another user is not allowed.',
    inputSchema: z.object({
      id: z.string().min(1),
      message: z.string().min(1).describe('Markdown message body.'),
      type: z
        .enum(['thread', 'channel', 'user'])
        .describe('Target kind: thread, channel, or user.'),
    }),
    execute: async ({ id, message, type }) => {
      if (!isOwner) {
        if (type === 'user') {
          return {
            error:
              'Not allowed: you can only post into the current channel, not DM another user.',
          };
        }
        if (rawChannelOf(id) !== currentChannel) {
          return {
            error:
              'Not allowed: you can only post into the channel you were mentioned in, not a different channel.',
          };
        }
      }
      // Broadcast pings (@channel/@here/@everyone) are owner-only, same as the
      // streamed reply; downgrade them to inert plaintext for everyone else.
      const body = isOwner ? message : neutralizeBroadcast(message);
      const identity = await resolveIdentity('normal');
      const content: PostContent = {
        iconEmoji: identity.iconEmoji,
        iconUrl: identity.iconUrl,
        markdown: body,
        username: identity.username,
      };
      if (type === 'thread') {
        const sent = await bot.thread(id).post(content);
        return { messageId: sent.id, threadId: sent.threadId };
      }
      if (type === 'channel') {
        const sent = await bot.channel(id).post(content);
        return { messageId: sent.id, threadId: sent.threadId };
      }
      const dm = await bot.openDM(id);
      const sent = await dm.post(content);
      return { messageId: sent.id, threadId: sent.threadId };
    },
  });
}
