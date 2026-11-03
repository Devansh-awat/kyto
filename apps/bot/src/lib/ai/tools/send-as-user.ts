import { getSlackGrant } from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import {
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  restoreAnnotatedMentions,
} from '@/harness/markdown';
import type { ThreadHandle as Thread } from '@/harness/thread';
import type { PendingPost } from '@/lib/confirm-post/pending';
import { requestPostConfirmation } from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import { normalizeSlackChannelArg, toRawSlackUserId } from '@/lib/slack/ids';
import { askerSlackToken, slackAuthorizeUrl } from '@/lib/slack-oauth';
import { errorMessage } from '@/lib/utils/error';
import { parseBlocks } from './post-message';

const postMessageSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

const openDmSchema = z.looseObject({
  channel: z.looseObject({ id: z.string() }).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

/**
 * The asker's own Slack token: their connected account, or for the owner the
 * env token from before grants existed (`askerSlackToken`). Never anyone
 * else's — every tool here acts only as the person who asked, so there is no
 * way to name another account.
 */
async function actorToken(
  userId: string
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const token = await askerSlackToken(userId);
  if (token) {
    return { ok: true, token };
  }
  const connect = slackAuthorizeUrl(userId);
  return {
    error: connect
      ? `<@${userId}> hasn't connected their Slack account, so kyto can't act as them. They can connect it here (only they can use this link): ${connect}`
      : 'Acting as a person needs their connected Slack account, and connecting accounts is not configured.',
    ok: false,
  };
}

async function callSlackAsUser({
  body,
  method,
  token,
}: {
  body: Record<string, unknown>;
  method: 'chat.delete' | 'chat.postMessage' | 'chat.update';
  token: string;
}): Promise<z.infer<typeof postMessageSchema>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  return postMessageSchema.parse(await response.json());
}

/**
 * Open (or find) the person's own DM with a user, using their token — so the
 * message lands in their IM with that user, not the app's bot DM.
 */
async function openOwnDm(
  token: string,
  userId: string
): Promise<{ channelId: string } | { error: string }> {
  const response = await fetch('https://slack.com/api/conversations.open', {
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ users: userId }),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  const result = openDmSchema.parse(await response.json());
  if (!(result.ok && result.channel?.id)) {
    return { error: `Could not open a DM with <@${userId}>: ${result.error}` };
  }
  return { channelId: result.channel.id };
}

interface ActResult {
  error?: string;
  success: boolean;
  summary?: string;
}
type AsUserPost = Extract<
  PendingPost,
  { kind: 'deleteAsUser' | 'editAsUser' | 'sendAsUser' }
>;

/**
 * Post AS the person who asked, with their own token. Shared by the confirm
 * handler and by the no-confirm path the person can choose in App Home.
 */
export async function executeSendAsUser({
  requestedBy,
  targetChannel,
  targetUser,
  text,
  blocks,
  threadTs,
  crossChannel,
}: Omit<
  Extract<PendingPost, { kind: 'sendAsUser' }>,
  'kind' | 'summary'
>): Promise<ActResult> {
  const gate = await actorToken(requestedBy);
  if (!gate.ok) {
    return { error: gate.error, success: false };
  }
  let channel = targetChannel;
  if (targetUser) {
    const dm = await openOwnDm(gate.token, targetUser);
    if ('error' in dm) {
      return { error: dm.error, success: false };
    }
    channel = dm.channelId;
  }
  if (!channel) {
    return { error: 'No target channel or user to send to.', success: false };
  }
  const result = await callSlackAsUser({
    body: {
      channel,
      text,
      ...(blocks ? { blocks } : {}),
      ...(!crossChannel && threadTs && { thread_ts: threadTs }),
    },
    method: 'chat.postMessage',
    token: gate.token,
  });
  if (!result.ok) {
    return {
      error: `Failed to send as <@${requestedBy}>: ${result.error}`,
      success: false,
    };
  }
  if (crossChannel) {
    logger.info(
      { requestedBy, targetChannel: channel, targetUser },
      '[sendAsUser] posted as a person outside the current channel'
    );
  }
  if (targetUser) {
    return {
      success: true,
      summary: `Sent the DM as <@${requestedBy}> to <@${targetUser}>.`,
    };
  }
  return {
    success: true,
    summary: crossChannel
      ? `Sent the message as <@${requestedBy}> to <#${channel}>.`
      : `Sent the message as <@${requestedBy}>.`,
  };
}

/** Edit one of the asker's own messages. Shared by the confirm handler. */
export async function executeEditAsUser({
  requestedBy,
  targetChannel,
  messageTs,
  text,
  blocks,
}: Omit<
  Extract<PendingPost, { kind: 'editAsUser' }>,
  'kind' | 'summary'
>): Promise<ActResult> {
  const gate = await actorToken(requestedBy);
  if (!gate.ok) {
    return { error: gate.error, success: false };
  }
  const result = await callSlackAsUser({
    body: {
      channel: targetChannel,
      text,
      ts: messageTs,
      ...(blocks ? { blocks } : {}),
    },
    method: 'chat.update',
    token: gate.token,
  });
  if (!result.ok) {
    return {
      error: `Failed to edit <@${requestedBy}>'s message: ${result.error}`,
      success: false,
    };
  }
  return { success: true, summary: `Edited <@${requestedBy}>'s message.` };
}

/** Delete one of the asker's own messages. Shared by the confirm handler. */
export async function executeDeleteAsUser({
  requestedBy,
  targetChannel,
  messageTs,
}: Omit<
  Extract<PendingPost, { kind: 'deleteAsUser' }>,
  'kind' | 'summary'
>): Promise<ActResult> {
  const gate = await actorToken(requestedBy);
  if (!gate.ok) {
    return { error: gate.error, success: false };
  }
  const result = await callSlackAsUser({
    body: { channel: targetChannel, ts: messageTs },
    method: 'chat.delete',
    token: gate.token,
  });
  if (!result.ok) {
    return {
      error: `Failed to delete <@${requestedBy}>'s message: ${result.error}`,
      success: false,
    };
  }
  return { success: true, summary: `Deleted <@${requestedBy}>'s message.` };
}

function executeAsUser(post: AsUserPost): Promise<ActResult> {
  if (post.kind === 'sendAsUser') {
    return executeSendAsUser(post);
  }
  if (post.kind === 'editAsUser') {
    return executeEditAsUser(post);
  }
  return executeDeleteAsUser(post);
}

/**
 * Run an as-the-person action: straight away if THEY turned the click off in
 * App Home, otherwise behind their own Confirm button (a prompt injection can
 * ask, not press). An unattended run has nobody to press it, so it refuses
 * rather than block ten minutes on a button no one will see.
 */
async function confirmOrRun({
  abortSignal,
  extendAttemptDeadline,
  post,
  thread,
  unattended,
}: {
  abortSignal?: AbortSignal;
  extendAttemptDeadline?: (extraMs: number) => () => void;
  post: AsUserPost;
  thread: Thread;
  unattended?: boolean;
}): Promise<ActResult> {
  const grant = await getSlackGrant(post.requestedBy).catch(() => null);
  if (grant?.skipConfirm) {
    logger.info(
      { kind: post.kind, requestedBy: post.requestedBy },
      '[sendAsUser] ran without a confirm click (turned off in App Home)'
    );
    return await executeAsUser(post);
  }
  if (unattended) {
    return {
      error: `Nobody is watching this run to click Confirm, so I did NOT ${post.summary}. <@${post.requestedBy}> can turn these confirmations off in kyto's App Home (Your Slack account) if they want it to happen unattended.`,
      success: false,
    };
  }
  return await requestPostConfirmation({
    abortSignal,
    approverUserId: post.requestedBy,
    extendAttemptDeadline,
    post,
    thread,
  });
}

interface AsUserToolOptions {
  authorUserId: string;
  extendAttemptDeadline?: (extraMs: number) => () => void;
  isOwner: boolean;
  thread: Thread;
  unattended?: boolean;
}

const CONFIRM_NOTE =
  "It waits for THEIR Confirm click (not the owner's) unless they turned confirmations off in kyto's App Home; the result says which. If they haven't connected their Slack account, the result has a link only they can use.";

function currentChannelOf(thread: Thread): {
  channel?: string;
  threadTs?: string;
} {
  const [platform, channel, threadTs] = thread.id.split(':');
  return platform === 'slack' && channel ? { channel, threadTs } : {};
}

function resolveChannelArg(
  channelId: string | undefined
): { channel?: string } | { error: string } {
  if (!channelId) {
    return {};
  }
  const raw = normalizeSlackChannelArg(channelId);
  if (!raw) {
    return {
      error: `"${channelId}" is not a Slack channel id: it looks like a message timestamp. Pass a channel id (C…/G…/D…) or an <#channel> mention.`,
    };
  }
  return { channel: raw };
}

/**
 * Send a message AS the person who asked, from their own Slack account — the
 * owner included. Never inline unless they waived the click in App Home: it
 * stages the post and shows THEM a confirm button.
 */
export function sendAsUserTool({
  authorUserId,
  extendAttemptDeadline,
  isOwner,
  thread,
  unattended,
}: AsUserToolOptions) {
  return tool({
    description: `Send a message AS the person who asked you (from their own Slack account, under their own name), not as kyto. Only ever as them: there is no way to send as anyone else. Defaults to the current thread. Pass channelId to post a top-level message in a channel they are in, or userId to DM someone from their account. Pass \`blocks\` to send Block Kit (the text becomes the notification fallback). ${CONFIRM_NOTE}`,
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'The message to post as them. With `blocks`, the notification fallback text.'
        ),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Target Slack channel id (e.g. C0123ABC) to post into as a top-level message. Defaults to the current thread.'
        ),
      userId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Target Slack user id (e.g. U0123ABC) to DM from their account. Mutually exclusive with channelId.'
        ),
      blocks: z
        .string()
        .optional()
        .describe(
          'Optional Block Kit payload: a JSON array of up to 50 blocks. Replaces the plain text body; `text` is still sent as the notification fallback.'
        ),
    }),
    execute: async (
      { text, channelId, userId, blocks: rawBlocks },
      { abortSignal }
    ) => {
      try {
        if (channelId && userId) {
          return {
            error: 'Pass channelId OR userId, not both.',
            success: false,
          };
        }
        const { channel: currentChannelId, threadTs } =
          currentChannelOf(thread);
        if (!currentChannelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        // Validate the target SHAPE before it can be queued and confirmed. A
        // timestamp mis-supplied as `channelId` (or a display name as `userId`)
        // otherwise sails through the gate and only fails deep in the Web API as
        // `channel_not_found` — sometimes after the click.
        const target = resolveChannelArg(channelId);
        if ('error' in target) {
          return { error: target.error, success: false };
        }
        let resolvedUser: string | undefined;
        if (userId) {
          const raw = toRawSlackUserId(userId);
          if (!raw) {
            return {
              error: `"${userId}" is not a Slack user id, so it can't be a DM target. Pass a user id (U…/W… or an <@mention>).`,
              success: false,
            };
          }
          resolvedUser = raw;
        }
        let blocks: unknown[] | undefined;
        if (rawBlocks) {
          const parsed = parseBlocks(rawBlocks);
          if (parsed.error) {
            return { error: parsed.error, success: false };
          }
          blocks = parsed.blocks;
        }
        const crossChannel = Boolean(
          resolvedUser ||
            (target.channel && target.channel !== currentChannelId)
        );
        // Same broadcast rule as postMessage: only the owner, and only here.
        // Under someone's own name it would still be kyto that fired the
        // @channel, and with confirmations off nobody would have seen it first.
        // Un-annotate mentions so a person named in the message is really
        // pinged (see restoreAnnotatedMentions); the strip runs after it.
        const restored = restoreAnnotatedMentions(text);
        const stripBroadcast = crossChannel || !isOwner;
        const body = stripBroadcast ? neutralizeBroadcast(restored) : restored;
        const safeBlocks =
          stripBroadcast && blocks ? neutralizeBroadcastDeep(blocks) : blocks;
        const targetChannel = resolvedUser
          ? undefined
          : (target.channel ?? currentChannelId);
        let summary = 'send as YOU in this thread';
        if (resolvedUser) {
          summary = `send as YOU in a DM to <@${resolvedUser}>`;
        } else if (crossChannel && targetChannel) {
          summary = `send as YOU to <#${targetChannel}>`;
        }
        return await confirmOrRun({
          abortSignal,
          extendAttemptDeadline,
          post: {
            blocks: safeBlocks,
            crossChannel,
            kind: 'sendAsUser',
            requestedBy: authorUserId,
            summary: blocks ? `${summary} (Block Kit)` : summary,
            targetChannel,
            targetUser: resolvedUser,
            text: body,
            threadTs,
          },
          thread,
          unattended,
        });
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[sendAsUser] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/**
 * Edit one of the asker's own messages, from their own account. Confirmed like
 * sendAsUser — editing under someone's name is as outward-facing as posting.
 */
export function editAsUserTool({
  authorUserId,
  extendAttemptDeadline,
  isOwner,
  thread,
  unattended,
}: AsUserToolOptions) {
  return tool({
    description: `Edit one of the asking person's OWN Slack messages, from their account (Slack refuses anyone else's). Defaults to the current channel; pass channelId for a message elsewhere. Pass \`blocks\` to replace it with Block Kit. ${CONFIRM_NOTE}`,
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of their message to edit, e.g. 1781599802.270109.'
        ),
      text: z
        .string()
        .min(1)
        .max(4000)
        .describe('The new message text to replace the existing content with.'),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Slack channel id (e.g. C0123ABC) the message lives in. Defaults to the current channel.'
        ),
      blocks: z
        .string()
        .optional()
        .describe(
          'Optional Block Kit payload: a JSON array of up to 50 blocks to replace the message content with; `text` becomes the notification fallback.'
        ),
    }),
    execute: async (
      { messageTs, text, channelId, blocks: rawBlocks },
      { abortSignal }
    ) => {
      try {
        const { channel: currentChannelId } = currentChannelOf(thread);
        if (!currentChannelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        let blocks: unknown[] | undefined;
        if (rawBlocks) {
          const parsed = parseBlocks(rawBlocks);
          if (parsed.error) {
            return { error: parsed.error, success: false };
          }
          blocks = parsed.blocks;
        }
        const target = resolveChannelArg(channelId);
        if ('error' in target) {
          return { error: target.error, success: false };
        }
        const targetChannel = target.channel ?? currentChannelId;
        // An edit can't ping anyone, but it can ADD an @channel to an old
        // message; same owner-only rule as a send.
        const restored = restoreAnnotatedMentions(text);
        return await confirmOrRun({
          abortSignal,
          extendAttemptDeadline,
          post: {
            blocks:
              blocks && !isOwner ? neutralizeBroadcastDeep(blocks) : blocks,
            kind: 'editAsUser',
            messageTs,
            requestedBy: authorUserId,
            summary: `edit YOUR message in <#${targetChannel}>`,
            targetChannel,
            text: isOwner ? restored : neutralizeBroadcast(restored),
          },
          thread,
          unattended,
        });
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[editAsUser] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/**
 * Delete one of the asker's own messages, from their own account. Can't be
 * undone, so it waits for their click like a send unless they waived it.
 */
export function deleteAsUserTool({
  authorUserId,
  extendAttemptDeadline,
  thread,
  unattended,
}: Omit<AsUserToolOptions, 'isOwner'>) {
  return tool({
    description: `Delete one of the asking person's OWN Slack messages, from their account. It cannot be undone. Defaults to the current channel; pass channelId for a message elsewhere. ${CONFIRM_NOTE}`,
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of their message to delete, e.g. 1781599802.270109.'
        ),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Slack channel id (e.g. C0123ABC) the message lives in. Defaults to the current channel.'
        ),
    }),
    execute: async ({ messageTs, channelId }, { abortSignal }) => {
      try {
        const { channel: currentChannelId } = currentChannelOf(thread);
        if (!currentChannelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        const target = resolveChannelArg(channelId);
        if ('error' in target) {
          return { error: target.error, success: false };
        }
        const targetChannel = target.channel ?? currentChannelId;
        return await confirmOrRun({
          abortSignal,
          extendAttemptDeadline,
          post: {
            kind: 'deleteAsUser',
            messageTs,
            requestedBy: authorUserId,
            summary: `DELETE your message ${messageTs} in <#${targetChannel}>`,
            targetChannel,
          },
          thread,
          unattended,
        });
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[deleteAsUser] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
