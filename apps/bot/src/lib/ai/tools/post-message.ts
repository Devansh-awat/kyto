import { tool } from 'ai';
import { z } from 'zod';
import {
  type KytoBot as Chat,
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  type PostContent,
} from '@/harness';
import { slack } from '@/lib/chat';
import { requestPostConfirmation } from '@/lib/confirm-post/request';
import { resolveIdentity } from '@/lib/identity';
import { toRawSlackChannelId } from '@/lib/slack/ids';

interface PostTarget {
  id: string;
  type: 'thread' | 'channel' | 'user';
}

/**
 * Actually deliver a post. Shared by the immediate (same-channel) path and by
 * the confirm-button handler, so a confirmed cross-channel post travels the
 * exact same code as an inline one.
 */
export async function executePostMessage(
  bot: Chat,
  {
    target,
    body,
    blocks,
  }: { target: PostTarget; body: string; blocks?: unknown[] }
): Promise<{ messageId: string; threadId: string }> {
  const identity = await resolveIdentity('normal');
  const content: PostContent = {
    ...(blocks ? { blocks, fallbackText: body } : { markdown: body }),
    iconEmoji: identity.iconEmoji,
    iconUrl: identity.iconUrl,
    username: identity.username,
  };
  if (target.type === 'thread') {
    const sent = await bot.thread(target.id).post(content);
    return { messageId: sent.id, threadId: sent.threadId };
  }
  if (target.type === 'channel') {
    const sent = await bot.channel(target.id).post(content);
    return { messageId: sent.id, threadId: sent.threadId };
  }
  const dm = await bot.openDM(target.id);
  const sent = await dm.post(content);
  return { messageId: sent.id, threadId: sent.threadId };
}

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
  authorUserId,
  bot,
  currentThreadId,
  extendAttemptDeadline,
  isOwner,
}: {
  authorUserId: string;
  bot: Chat;
  currentThreadId: string;
  extendAttemptDeadline?: (extraMs: number) => void;
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
          `Optional Block Kit payload: a JSON array of up to ${MAX_BLOCKS} blocks (e.g. [{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]). Replaces the markdown body; \`message\` is still sent as the notification fallback. Do NOT append a "Posted by kyto"/"sent by kyto in #channel" or any author/attribution context block — Slack already shows who sent the message and the channel, so such a footer is noise; only include blocks that carry real content.`
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
    execute: async (
      { blocks: rawBlocks, id, message, type },
      { abortSignal }
    ) => {
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

      // A post that leaves the current channel (a different channel, or a DM to
      // someone) is only reachable by the owner, and now never fires inline: it
      // waits for the owner to click a confirm button. This is the human-click
      // gate that a prompt injection cannot forge — it can request the post but
      // can't press the button. Same-channel replies still post immediately.
      const crossChannel = type === 'user' || target !== currentChannel;
      if (crossChannel) {
        const where =
          type === 'user' ? `a DM to <@${id}>` : `<#${target ?? id}>`;
        return await requestPostConfirmation({
          abortSignal,
          extendAttemptDeadline,
          ownerUserId: authorUserId,
          post: {
            blocks,
            body,
            kind: 'postMessage',
            requestedBy: authorUserId,
            summary: `post to ${where}${blocks ? ' (Block Kit)' : ''}`,
            target: { id, type },
          },
          thread: bot.thread(currentThreadId),
        });
      }

      return await executePostMessage(bot, {
        blocks,
        body,
        target: { id, type },
      });
    },
  });
}
