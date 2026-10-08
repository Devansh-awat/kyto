import { WebClient } from '@slack/web-api';
import { tool } from 'ai';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  parseSlackPermalink,
  toChatSlackChannelId,
  toRawSlackChannelId,
} from '@/lib/slack/ids';
import { askerSlackToken, slackAuthorizeUrl } from '@/lib/slack-oauth';
import { assertReadableChannel, joinChannel } from './utils';

export function readConversationHistoryTool({
  askerUserId,
  currentThreadId,
}: {
  askerUserId: string;
  currentThreadId: string;
}) {
  return tool({
    description:
      "Read channel history or thread replies. The current conversation is always readable. Another private channel, DM or group DM — including the person's DMs with other people or apps — is read with THEIR OWN connected Slack account, so it works for any conversation they are in once they have connected one (the error links them to it otherwise).",
    inputSchema: z.object({
      permalink: z
        .string()
        .optional()
        .describe(
          'A Slack message link (https://….slack.com/archives/C…/p…), pasted whole. Reads the thread that message is in; channelId and threadTs are then not needed. Prefer this to converting a link by hand.'
        ),
      channelId: z.string().optional(),
      threadId: z.string().optional(),
      threadTs: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(40),
      cursor: z
        .string()
        .optional()
        .describe('Slack pagination cursor from a previous response.'),
    }),
    execute: async ({
      channelId,
      cursor,
      limit,
      permalink,
      threadId,
      threadTs,
    }) => {
      const link = permalink?.trim() ? parseSlackPermalink(permalink) : null;
      if (permalink?.trim() && !link) {
        throw new Error(
          `${permalink} is not a Slack message link (https://<workspace>.slack.com/archives/<CHANNEL>/p<digits>).`
        );
      }
      // gpt-6-luna fills every optional field, so an unused one arrives as "".
      const decodedThread = threadId?.startsWith('slack:')
        ? slack.decodeThreadId(threadId)
        : undefined;
      const resolvedChannelId =
        link?.channelId ||
        channelId ||
        (decodedThread ? `slack:${decodedThread.channel}` : undefined);
      const resolvedThreadTs =
        link?.threadTs || threadTs || decodedThread?.threadTs || undefined;
      if (!resolvedChannelId) {
        throw new Error('readConversationHistory needs channelId or threadId.');
      }

      const chatChannelId = toChatSlackChannelId(resolvedChannelId);

      const refusal = await assertReadableChannel(chatChannelId, {
        askerUserId,
        currentThreadId,
      }).then(
        () => undefined,
        (error: unknown) => error
      );
      if (refusal) {
        // kyto's bot can't read it (a DM, or a private channel it isn't in —
        // or one the asker isn't in). The asker's OWN token can read exactly
        // the conversations they are in, so asking for one of theirs is the
        // consent (owner's call 2026-10-05: no click per read).
        const token = await askerSlackToken(askerUserId);
        if (!token) {
          const connect = slackAuthorizeUrl(askerUserId);
          throw new Error(
            connect
              ? `kyto's bot can't read that conversation. If it is one the person is in, they can connect their own Slack account and kyto will read it as them: ${connect}`
              : String(refusal instanceof Error ? refusal.message : refusal)
          );
        }
        return await readAsAsker({
          channel: toRawSlackChannelId(chatChannelId),
          cursor,
          limit,
          threadTs: resolvedThreadTs,
          token,
        });
      }

      await joinChannel(chatChannelId);

      const result = await (resolvedThreadTs
        ? slack.fetchMessages(`${chatChannelId}:${resolvedThreadTs}`, {
            cursor,
            limit,
          })
        : slack.fetchChannelMessages(chatChannelId, {
            cursor,
            limit,
          })
      ).catch((error: unknown) => {
        // A bare thread_not_found read as "that thread is gone"; it is almost
        // always a channel or ts copied wrong from a link.
        if (String(error).includes('thread_not_found') && !link) {
          throw new Error(
            `No message ${resolvedThreadTs} in ${chatChannelId}. If this came from a link, pass the whole link as \`permalink\` instead of copying the channel and ts out of it.`
          );
        }
        throw error;
      });

      return {
        channelId: chatChannelId,
        messages: result.messages.map((message) => ({
          id: message.id,
          threadId: message.threadId,
          text: message.text,
          author: {
            userId: message.author.userId,
            userName: message.author.userName,
            fullName: message.author.fullName,
            isBot: message.author.isBot,
            isMe: message.author.isMe,
          },
          dateSent: message.metadata.dateSent?.toISOString(),
          edited: message.metadata.edited,
          isMention: message.isMention,
          attachments: (message.attachments ?? []).map((attachment) => ({
            type: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
            url: attachment.url,
          })),
        })),
        nextCursor: result.nextCursor,
        threadTs: resolvedThreadTs ?? null,
      };
    },
  });
}

const askerMessageSchema = z.looseObject({
  bot_id: z.string().optional(),
  edited: z.unknown().optional(),
  files: z
    .array(
      z.looseObject({
        mimetype: z.string().optional(),
        name: z.string().optional(),
      })
    )
    .optional(),
  reply_count: z.number().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string(),
  user: z.string().optional(),
  username: z.string().optional(),
});
const askerHistorySchema = z.looseObject({
  messages: z.array(askerMessageSchema).default([]),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

const MS_PER_SECOND = 1000;

/** A conversation read with the asker's own token: only theirs can be read. */
async function readAsAsker({
  channel,
  cursor,
  limit,
  threadTs,
  token,
}: {
  channel: string;
  cursor?: string;
  limit: number;
  threadTs?: string;
  token: string;
}) {
  const client = new WebClient(token);
  const raw = threadTs
    ? await client.conversations.replies({
        channel,
        cursor,
        limit,
        ts: threadTs,
      })
    : await client.conversations.history({ channel, cursor, limit });
  const page = askerHistorySchema.parse(raw);
  logger.info(
    { channel, count: page.messages.length, threadTs },
    "[readConversationHistory] read with the asker's own token"
  );
  return {
    channelId: channel,
    messages: page.messages.map((message) => ({
      author: {
        isBot: Boolean(message.bot_id),
        userId: message.user,
        userName: message.username,
      },
      dateSent: new Date(Number(message.ts) * MS_PER_SECOND).toISOString(),
      edited: Boolean(message.edited),
      files: (message.files ?? []).map(({ mimetype, name }) => ({
        mimeType: mimetype,
        name,
      })),
      id: message.ts,
      replyCount: message.reply_count,
      text: message.text ?? '',
      threadTs: message.thread_ts,
    })),
    nextCursor: page.response_metadata?.next_cursor || undefined,
    readAs: 'the asker (their own Slack account)',
    threadTs: threadTs ?? null,
  };
}
