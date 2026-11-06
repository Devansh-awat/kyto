import { randomUUID } from 'node:crypto';
import {
  consumeNextRunAsUserApproval,
  createAsUserRequest,
  getSlackGrant,
  setAsUserRequestCard,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import {
  neutralizeBroadcast,
  neutralizeBroadcastDeep,
  restoreAnnotatedMentions,
} from '@/harness/markdown';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { mrkdwn, plainText } from '@/harness/views';
import { slack } from '@/lib/chat';
import type { PendingPost } from '@/lib/confirm-post/pending';
import { requestPostConfirmation } from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import {
  normalizeSlackChannelArg,
  parseSlackPermalink,
  toRawSlackUserId,
} from '@/lib/slack/ids';
import { askerSlackToken, slackAuthorizeUrl } from '@/lib/slack-oauth';
import { errorMessage } from '@/lib/utils/error';
import { parseBlocks } from './post-message';

const postMessageSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

const uploadUrlSchema = z.looseObject({
  error: z.string().optional(),
  file_id: z.string().optional(),
  ok: z.boolean(),
  upload_url: z.string().optional(),
});

// Slack refuses image blocks pointing at its own private file URLs, and a
// model with no upload in hand invented one (`T00000000-F00000000`, #187).
const SLACK_FILE_URL =
  /https?:\/\/(?:files\.slack\.com|[a-z0-9-]+\.slack-files\.com)\//i;

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
  method:
    | 'chat.delete'
    | 'chat.postMessage'
    | 'chat.update'
    | 'files.completeUploadExternal'
    | 'files.getUploadURLExternal';
  token: string;
}): Promise<z.infer<typeof postMessageSchema>> {
  // The files.* methods take form fields (arrays as JSON strings), not JSON.
  const form = method.startsWith('files.');
  const response = await fetch(`https://slack.com/api/${method}`, {
    signal: AbortSignal.timeout(15_000),
    body: form
      ? new URLSearchParams(
          Object.entries(body).map(([key, value]): [string, string] => [
            key,
            typeof value === 'string' ? value : JSON.stringify(value),
          ])
        )
      : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json; charset=utf-8',
    },
    method: 'POST',
  });
  return postMessageSchema.parse(await response.json());
}

/** A reconnect line for a grant from before `files:write` was asked for. */
function reconnectForFiles(userId: string): string {
  const connect = slackAuthorizeUrl(userId);
  return `<@${userId}>'s Slack connection is older than file sending, so kyto can't attach files as them yet.${connect ? ` They can reconnect here (only they can use this link) and ask again: ${connect}` : ''} Until then, send the text with sendAsUser and upload the file to this thread with uploadFile.`;
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

/** A saved request's payload, re-validated when its card is clicked. */
export const asUserPostSchema = z.discriminatedUnion('kind', [
  z.object({
    blocks: z.array(z.unknown()).optional(),
    crossChannel: z.boolean(),
    files: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    inThread: z.string().optional(),
    kind: z.literal('sendAsUser'),
    requestedBy: z.string(),
    summary: z.string(),
    targetChannel: z.string().optional(),
    targetUser: z.string().optional(),
    text: z.string(),
    threadTs: z.string().optional(),
  }),
  z.object({
    blocks: z.array(z.unknown()).optional(),
    kind: z.literal('editAsUser'),
    messageTs: z.string(),
    requestedBy: z.string(),
    summary: z.string(),
    targetChannel: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('deleteAsUser'),
    messageTs: z.string(),
    requestedBy: z.string(),
    summary: z.string(),
    targetChannel: z.string(),
  }),
]);

export const AS_USER_SEND_ONCE_ACTION = 'as_user_send_once';
export const AS_USER_ALWAYS_ACTION = 'as_user_always';
export const AS_USER_CANCEL_ACTION = 'as_user_cancel';

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
  inThread,
  files,
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
  const replyTo = inThread ?? (crossChannel ? undefined : threadTs);
  // With files, completing their upload IS the post: the text rides along as
  // its message, so the files and the words land together.
  const result =
    files && files.length > 0
      ? await callSlackAsUser({
          body: {
            channel_id: channel,
            files,
            ...(blocks ? { blocks } : { initial_comment: text }),
            ...(replyTo && { thread_ts: replyTo }),
          },
          method: 'files.completeUploadExternal',
          token: gate.token,
        })
      : await callSlackAsUser({
          body: {
            channel,
            text,
            ...(blocks ? { blocks } : {}),
            ...(replyTo && { thread_ts: replyTo }),
          },
          method: 'chat.postMessage',
          token: gate.token,
        });
  if (!result.ok) {
    return {
      error:
        result.error === 'missing_scope' && files?.length
          ? reconnectForFiles(requestedBy)
          : `Failed to send as <@${requestedBy}>: ${result.error}`,
      success: false,
    };
  }
  if (crossChannel) {
    logger.info(
      { requestedBy, targetChannel: channel, targetUser },
      '[sendAsUser] posted as a person outside the current channel'
    );
  }
  const attached = files?.length
    ? ` with ${files.map((file) => file.title).join(', ')} attached`
    : '';
  if (targetUser) {
    return {
      success: true,
      summary: `Sent the DM as <@${requestedBy}> to <@${targetUser}>${attached}.`,
    };
  }
  let where = '';
  if (inThread) {
    where = ` in the thread in <#${channel}>`;
  } else if (crossChannel) {
    where = ` to <#${channel}>`;
  }
  return {
    success: true,
    summary: `Sent the message as <@${requestedBy}>${where}${attached}.`,
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

export function executeAsUser(post: AsUserPost): Promise<ActResult> {
  if (post.kind === 'sendAsUser') {
    return executeSendAsUser(post);
  }
  if (post.kind === 'editAsUser') {
    return executeEditAsUser(post);
  }
  return executeDeleteAsUser(post);
}

/** A reminder run's standing permission to act as its creator. */
interface AsUserRun {
  approval: 'always' | 'ask' | 'next';
  reminderId: string;
}

/**
 * A reminder run can't wait on a click, so the action is SAVED and its creator
 * gets a DM card: send it once, send it and stop asking for this reminder, or
 * cancel. Answerable for a day, across restarts (`as_user_requests`).
 */
async function saveForLater({
  post,
  reminderId,
}: {
  post: AsUserPost;
  reminderId: string;
}): Promise<ActResult & { queued?: boolean }> {
  const id = randomUUID();
  await createAsUserRequest({
    id,
    payload: post,
    reminderId,
    summary: post.summary,
    userId: post.requestedBy,
  });
  const preview =
    post.kind === 'deleteAsUser' ? '' : post.text.trim().slice(0, 500);
  const card = await slack.webClient.chat.postMessage({
    blocks: [
      {
        text: mrkdwn(
          `:alarm_clock: *Your scheduled job wants to act as you*\n${post.summary}`
        ),
        type: 'section',
      },
      ...(preview
        ? [{ text: mrkdwn(`>>> ${preview}`), type: 'section' as const }]
        : []),
      {
        elements: [
          {
            action_id: AS_USER_SEND_ONCE_ACTION,
            style: 'primary',
            text: plainText('Send this once'),
            type: 'button',
            value: id,
          },
          {
            action_id: AS_USER_ALWAYS_ACTION,
            text: plainText('Always for this job'),
            type: 'button',
            value: id,
          },
          {
            action_id: AS_USER_CANCEL_ACTION,
            style: 'danger',
            text: plainText('Cancel'),
            type: 'button',
            value: id,
          },
        ],
        type: 'actions',
      },
      {
        elements: [
          mrkdwn(
            '_good for 24 hours. "always" sends this and lets this job act as you from now on, and you can change that in my app home_'
          ),
        ],
        type: 'context',
      },
    ],
    channel: post.requestedBy,
    text: `Your scheduled job wants to ${post.summary}`,
  });
  if (card.channel && card.ts) {
    await setAsUserRequestCard({ channel: card.channel, id, ts: card.ts });
  }
  return {
    queued: true,
    success: false,
    summary: `Not done yet: saved for <@${post.requestedBy}> to approve from a DM (to ${post.summary}); it goes out when they click. Do NOT retry it or send it another way, and don't call it sent. Carry on with the rest of the job.`,
  };
}

/**
 * Run an as-the-person action: straight away if THEY turned the click off in
 * App Home (or pre-approved this reminder), otherwise behind their own Confirm
 * button — a prompt injection can ask, not press. A reminder run saves it for a
 * later click instead; any other unattended run refuses.
 */
async function confirmOrRun({
  abortSignal,
  asUserRun,
  extendAttemptDeadline,
  post,
  thread,
  unattended,
}: {
  abortSignal?: AbortSignal;
  asUserRun?: AsUserRun;
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
  if (asUserRun && asUserRun.approval !== 'ask') {
    if (asUserRun.approval === 'next') {
      await consumeNextRunAsUserApproval(asUserRun.reminderId);
    }
    logger.info(
      {
        approval: asUserRun.approval,
        kind: post.kind,
        reminderId: asUserRun.reminderId,
      },
      "[sendAsUser] ran on the reminder creator's pre-approval"
    );
    return await executeAsUser(post);
  }
  if (asUserRun) {
    return await saveForLater({ post, reminderId: asUserRun.reminderId });
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
  asUserRun?: AsUserRun;
  authorUserId: string;
  extendAttemptDeadline?: (extraMs: number) => () => void;
  isOwner: boolean;
  thread: Thread;
  unattended?: boolean;
}

type StageFile = (input: { path: string }) => Promise<{
  filename: string;
  send: (uploadUrl: string) => Promise<void>;
  size: number;
}>;

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
 * Upload a sandbox file with the ASKER's token, without sharing it: the
 * upload URL is one-shot for that file, so the sandbox sends the bytes and the
 * token stays on the host. It is only shared once the post is confirmed; an
 * unconfirmed upload is discarded by Slack.
 */
async function stageForSend({
  filePath,
  requestedBy,
  savedForLater,
  stageFile,
}: {
  filePath: string;
  requestedBy: string;
  savedForLater: boolean;
  stageFile?: StageFile;
}): Promise<{ file: { id: string; title: string } } | { error: string }> {
  if (!stageFile) {
    return {
      error:
        'Attaching a file needs the sandbox, which this run has no access to.',
    };
  }
  // A reminder's saved request waits up to a day for its card, longer than an
  // unfinished upload is kept.
  if (savedForLater) {
    return {
      error:
        "A reminder run can't hold a file for the creator's approval card. Send the text, and say the file couldn't go with it.",
    };
  }
  const gate = await actorToken(requestedBy);
  if (!gate.ok) {
    return { error: gate.error };
  }
  const grant = await getSlackGrant(requestedBy).catch(() => null);
  if (grant && !grant.scopes.split(/[\s,]+/).includes('files:write')) {
    return { error: reconnectForFiles(requestedBy) };
  }
  const file = await stageFile({ path: filePath });
  const target = uploadUrlSchema.parse(
    await callSlackAsUser({
      body: { filename: file.filename, length: String(file.size) },
      method: 'files.getUploadURLExternal',
      token: gate.token,
    })
  );
  if (!(target.ok && target.upload_url && target.file_id)) {
    return {
      error:
        target.error === 'missing_scope'
          ? reconnectForFiles(requestedBy)
          : `Slack wouldn't take ${file.filename} from <@${requestedBy}>'s account: ${target.error ?? 'no upload URL'}`,
    };
  }
  await file.send(target.upload_url);
  return { file: { id: target.file_id, title: file.filename } };
}

/**
 * Send a message AS the person who asked, from their own Slack account — the
 * owner included. Never inline unless they waived the click in App Home: it
 * stages the post and shows THEM a confirm button.
 */
export function sendAsUserTool({
  asUserRun,
  authorUserId,
  extendAttemptDeadline,
  isOwner,
  stageFile,
  thread,
  unattended,
}: AsUserToolOptions & { stageFile?: StageFile }) {
  return tool({
    description: `Send a message AS the person who asked you (from their own Slack account, under their own name), not as kyto. Only ever as them: there is no way to send as anyone else. Defaults to the current thread. Pass channelId to post a top-level message in a channel they are in, threadLink to reply inside a thread anywhere they can post (a Slack message link), or userId to DM someone from their account. Pass filePath to attach a file from the sandbox (a picture, a PDF): it goes out with the message, from their account. Never put a Slack file URL in blocks: those never display, so attach with filePath instead. Pass \`blocks\` to send Block Kit (the text becomes the notification fallback). ${CONFIRM_NOTE}`,
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
      threadLink: z
        .string()
        .min(1)
        .optional()
        .describe(
          'A Slack message link (https://….slack.com/archives/C…/p…): the message is posted as a reply in THAT thread, in that channel. Use it for "post it as me in that thread". Not with channelId or userId.'
        ),
      filePath: z
        .string()
        .min(1)
        .optional()
        .describe(
          'A file in the sandbox workspace to attach, sent from their account with the text as its message.'
        ),
      blocks: z
        .string()
        .optional()
        .describe(
          'Optional Block Kit payload: a JSON array of up to 50 blocks. Replaces the plain text body; `text` is still sent as the notification fallback.'
        ),
    }),
    execute: async (
      { text, channelId, userId, threadLink, filePath, blocks: rawBlocks },
      { abortSignal }
    ) => {
      try {
        if ([channelId, userId, threadLink].filter(Boolean).length > 1) {
          return {
            error: 'Pass only one of channelId, userId or threadLink.',
            success: false,
          };
        }
        const link = threadLink ? parseSlackPermalink(threadLink) : undefined;
        if (link === null) {
          return {
            error: `"${threadLink}" is not a Slack message link. Pass the link to a message in the thread (Copy link in Slack).`,
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
        const target = link
          ? { channel: link.channelId }
          : resolveChannelArg(channelId);
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
          if (SLACK_FILE_URL.test(rawBlocks)) {
            return {
              error:
                'blocks point at a Slack file URL, which never displays in a block (and one made up is a broken link). Attach the file with filePath instead, or leave the image out.',
              success: false,
            };
          }
        }
        // The same thread we're in, linked: just a reply here.
        const inThread =
          link &&
          !(link.channelId === currentChannelId && link.threadTs === threadTs)
            ? link.threadTs
            : undefined;
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
        // Their own DM with kyto: a message from them there is just a new
        // message TO kyto, which would start another turn.
        if (targetChannel?.startsWith('D')) {
          return {
            error:
              'That is their DM with kyto, so a message from them there would only be talking to kyto. Pass userId to DM someone, or channelId to post in a channel.',
            success: false,
          };
        }
        let summary = 'send as YOU in this thread';
        if (resolvedUser) {
          summary = `send as YOU in a DM to <@${resolvedUser}>`;
        } else if (inThread && targetChannel) {
          summary = `send as YOU in a thread in <#${targetChannel}>`;
        } else if (crossChannel && targetChannel) {
          summary = `send as YOU to <#${targetChannel}>`;
        }
        let files: { id: string; title: string }[] | undefined;
        if (filePath) {
          const staged = await stageForSend({
            filePath,
            requestedBy: authorUserId,
            savedForLater: asUserRun?.approval === 'ask',
            stageFile,
          });
          if ('error' in staged) {
            return { error: staged.error, success: false };
          }
          files = [staged.file];
          summary = `${summary}, with ${staged.file.title} attached`;
        }
        return await confirmOrRun({
          abortSignal,
          asUserRun,
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
            ...(inThread && { inThread }),
            ...(files && { files }),
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
  asUserRun,
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
          asUserRun,
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
  asUserRun,
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
          asUserRun,
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
