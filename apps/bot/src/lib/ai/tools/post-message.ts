import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import {
  type KytoBot as Chat,
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  type PostContent,
  restoreAnnotatedMentions,
} from '@/harness';
import { slack } from '@/lib/chat';
import { requestPostConfirmation } from '@/lib/confirm-post/request';
import { type ResolvedIdentity, resolveIdentity } from '@/lib/identity';
import { resolvePostIdentity } from '@/lib/post-identity';
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
    allowBroadcast = false,
    target,
    body,
    blocks,
    identity: override,
  }: {
    /**
     * Whether this post may carry a real @channel/@here ping. Only the caller
     * knows — the gate is "owner AND the channel kyto was invoked in" — and
     * `ThreadHandle.post` strips broadcasts unless told otherwise, so an
     * omitted flag fails CLOSED.
     */
    allowBroadcast?: boolean;
    target: PostTarget;
    body: string;
    blocks?: unknown[];
    identity?: ResolvedIdentity;
  }
): Promise<{ messageId: string; threadId: string }> {
  // A per-post override (custom name/icon, or a person/bot to mirror) replaces
  // kyto's configured identity; without one, the normal profile applies.
  const identity = override ?? (await resolveIdentity('normal'));
  const content: PostContent = {
    ...(blocks ? { blocks, fallbackText: body } : { markdown: body }),
    allowBroadcast,
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

export function parseBlocks(raw: string): {
  blocks?: unknown[];
  error?: string;
} {
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
    : "You may post into the current channel/thread (type thread or channel, the same channel you were mentioned in) freely. A DM to a user (type user) is allowed ONLY with the owner's approval — it is held until the owner clicks Confirm, which can take a while or never come. Posting into a different channel is not allowed.";
  return tool({
    description: `Post a message. ${permission} Body is markdown; pass \`blocks\` to send Block Kit instead (the markdown body is then the notification fallback text). Broadcast pings (<!channel>/<!here>/<!everyone>) NEVER survive a post into a different channel or a DM — they are stripped to plain text there even for the owner, who can only broadcast in the channel kyto was invoked in.${
      isOwner
        ? ' You can post under a custom identity: `asName` + `asIcon` for a fully custom display name and avatar, or `asUser` (a user/bot id or @mention) to post looking like that person/bot (their name + avatar). Slack still marks it as an app.'
        : ''
    }`,
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
      asName: z
        .string()
        .optional()
        .describe(
          "Owner only. Custom display name to post under (overrides kyto's name and any asUser name)."
        ),
      asIcon: z
        .string()
        .optional()
        .describe(
          'Owner only. Avatar for the post: a :emoji: code or an https image URL. Overrides any asUser avatar.'
        ),
      asUser: z
        .string()
        .optional()
        .describe(
          "Owner only. A user/bot id or @mention to mirror — the post wears that person/bot's display name and avatar. A plain name (not an id) is used as the display name only."
        ),
    }),
    execute: async (
      { blocks: rawBlocks, id, message, type, asName, asIcon, asUser },
      { abortSignal }
    ) => {
      const target = type === 'user' ? undefined : rawChannelOf(id);
      if (!(isOwner || type === 'user') && target !== currentChannel) {
        return {
          error:
            'Not allowed: you can only post into the channel you were mentioned in, not a different channel.',
        };
      }
      // A non-owner's DM request is not refused — it is held for the OWNER to
      // approve. Without a configured owner there is nobody to approve, so it
      // stays impossible.
      if (!isOwner && type === 'user' && !env.OWNER_USER_ID) {
        return {
          error:
            'Not allowed: DMing a user requires owner approval, and no owner is configured.',
        };
      }
      // Broadcast pings are owner-only AND here-only: a post that lands anywhere
      // other than the channel kyto was invoked in never notifies, even for the
      // owner. Being allowed to post into #announcements is not the same as
      // being allowed to @channel a room kyto isn't part of the conversation in
      // — the owner can send that ping from the channel itself if they mean it.
      const allowBroadcast = isOwner && target === currentChannel;
      // Un-annotate mentions the same way the streamed reply does, so a person
      // named in a posted message actually gets pinged (see
      // restoreAnnotatedMentions). Runs BEFORE the broadcast strip, which can
      // then still neutralize anything the model wrote.
      const restored = restoreAnnotatedMentions(message);
      const body = allowBroadcast ? restored : neutralizeBroadcast(restored);

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

      // Owner-only: wear a custom name/icon or mirror a person/bot. A non-owner
      // (who can only post same-channel) must not be able to post under someone
      // else's name — that is the impersonation vector. Overrides are ignored
      // for them; kyto's normal identity applies.
      const identity = isOwner
        ? await resolvePostIdentity({ asIcon, asName, asUser })
        : undefined;

      // A post that leaves the current channel (a different channel, or a DM to
      // someone) is only reachable by the owner, and now never fires inline: it
      // waits for the owner to click a confirm button. This is the human-click
      // gate that a prompt injection cannot forge — it can request the post but
      // can't press the button. Same-channel replies still post immediately.
      const crossChannel = type === 'user' || target !== currentChannel;
      if (crossChannel) {
        const where =
          type === 'user' ? `a DM to <@${id}>` : `<#${target ?? id}>`;
        // The confirm click always belongs to the OWNER — for a non-owner's DM
        // request the button lands in the owner's DM (fallbackToDM), and the
        // summary names who asked so the owner knows whose words these are.
        const requestedFor =
          authorUserId === env.OWNER_USER_ID
            ? ''
            : ` (requested by <@${authorUserId}>)`;
        return await requestPostConfirmation({
          abortSignal,
          extendAttemptDeadline,
          ownerUserId: env.OWNER_USER_ID ?? authorUserId,
          post: {
            blocks,
            body,
            identity,
            kind: 'postMessage',
            requestedBy: authorUserId,
            summary: `post to ${where}${blocks ? ' (Block Kit)' : ''}${identity?.username ? ` as "${identity.username}"` : ''}${requestedFor}`,
            target: { id, type },
          },
          thread: bot.thread(currentThreadId),
        });
      }

      return await executePostMessage(bot, {
        // Same-channel owner post: the only postMessage that may really ping.
        // A cross-channel/DM post never reaches here — it goes through the
        // confirm gate above, where allowBroadcast is left off.
        allowBroadcast,
        blocks,
        body,
        identity,
        target: { id, type },
      });
    },
  });
}
