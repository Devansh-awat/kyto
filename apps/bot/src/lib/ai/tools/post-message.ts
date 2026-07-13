import { tool } from 'ai';
import { z } from 'zod';
import {
  type KytoBot as Chat,
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  type PostContent,
} from '@/harness';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import { toRawSlackChannelId } from '@/lib/slack/ids';

// Slack rejects a message with more than 50 blocks.
const MAX_BLOCKS = 50;

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

function parseBlocks(raw: string): { blocks?: unknown[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'blocks must be a valid JSON array of Block Kit blocks.' };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'blocks must be a JSON ARRAY of Block Kit blocks.' };
  }
  if (parsed.length === 0 || parsed.length > MAX_BLOCKS) {
    return { error: `blocks must hold 1 to ${MAX_BLOCKS} blocks.` };
  }
  return { blocks: parsed };
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
  const permission = isOwner
    ? 'Post to another target. Type must be thread, channel, or user.'
    : 'You may ONLY post into the current channel/thread (type thread or channel, the same channel you were mentioned in) — posting to a different channel or DMing another user is not allowed.';
  return tool({
    description: `Post a message. ${permission} Body is markdown; pass \`blocks\` to send Block Kit instead (the markdown body is then the notification fallback text). Broadcast pings (<!channel>/<!here>/<!everyone>) NEVER survive a post into a different channel or a DM — they are stripped to plain text there even for the owner, who can only broadcast in the channel kyto was invoked in.`,
    inputSchema: z.object({
      blocks: z
        .string()
        .optional()
        .describe(
          `Optional Block Kit payload: a JSON array of up to ${MAX_BLOCKS} blocks (e.g. [{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]). Replaces the markdown body; \`message\` is still sent as the notification fallback.`
        ),
      id: z.string().min(1),
      message: z
        .string()
        .min(1)
        .describe(
          'Markdown message body. With `blocks`, this is the notification fallback text.'
        ),
      type: z
        .enum(['thread', 'channel', 'user'])
        .describe('Target kind: thread, channel, or user.'),
    }),
    execute: async ({ blocks: rawBlocks, id, message, type }) => {
      const target = type === 'user' ? undefined : rawChannelOf(id);
      if (!isOwner) {
        if (type === 'user') {
          return {
            error:
              'Not allowed: you can only post into the current channel, not DM another user.',
          };
        }
        if (target !== currentChannel) {
          return {
            error:
              'Not allowed: you can only post into the channel you were mentioned in, not a different channel.',
          };
        }
      }
      // Broadcast pings are owner-only AND here-only: a post that lands anywhere
      // other than the channel kyto was invoked in never notifies, even for the
      // owner. Being allowed to post into #announcements is not the same as
      // being allowed to @channel a room kyto isn't part of the conversation in
      // — the owner can send that ping from the channel itself if they mean it.
      const allowBroadcast = isOwner && target === currentChannel;
      const body = allowBroadcast ? message : neutralizeBroadcast(message);

      let blocks: unknown[] | undefined;
      if (rawBlocks) {
        const parsed = parseBlocks(rawBlocks);
        if (parsed.error) {
          return { error: parsed.error };
        }
        blocks = allowBroadcast
          ? parsed.blocks
          : neutralizeBroadcastDeep(parsed.blocks);
      }

      const identity = await resolveIdentity('normal');
      const content: PostContent = {
        ...(blocks ? { blocks, fallbackText: body } : { markdown: body }),
        iconEmoji: identity.iconEmoji,
        iconUrl: identity.iconUrl,
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
