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
import { rememberRepeatReads } from './repeat-reads';
import {
  assertReadableChannel,
  joinChannel,
  markStoredSelfMention,
} from './utils';

export function readConversationHistoryTool({
  askerUserId,
  currentThreadId,
}: {
  askerUserId: string;
  currentThreadId: string;
}) {
  return tool({
    description:
      "Read channel history or thread replies. The current conversation is always readable. Another private channel, DM or group DM (including the person's DMs with other people or apps) is read with THEIR OWN connected Slack account, so it works for any conversation they are in once they have connected one (the error links them to it otherwise).",
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
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(40)
        .describe('How many messages, counted back from the NEWEST.'),
      after: z
        .string()
        .optional()
        .describe(
          "A message ts: only messages posted after it. To poll for replies to your own post, pass that post's ts: one call per check."
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          'The `nextCursor` from a previous readConversationHistory response, verbatim. NOT a message ts: to start at a message, pass it as threadTs or permalink.'
        ),
    }),
    execute: rememberRepeatReads(
      async ({
        after,
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
          throw new Error(
            'readConversationHistory needs channelId or threadId.'
          );
        }
        // A message ts passed as the cursor came back `invalid_cursor` four times
        // in one turn, each a 3-4s round trip, and the model kept guessing (#65).
        if (cursor && MESSAGE_TS.test(cursor)) {
          throw new Error(
            `cursor ${cursor} is a message timestamp, not a pagination cursor. Pass the nextCursor from the previous response, or omit cursor and pass the thread's ts as threadTs to start from its first page.`
          );
        }

        const oldest = after?.trim() || undefined;
        if (oldest && !MESSAGE_TS.test(oldest)) {
          throw new Error(
            `after must be a message ts like 1791695940.351679, not ${oldest}.`
          );
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
                ? `kyto's bot can't read that conversation (a DM, or a private channel kyto isn't in), so reading its history won't work. To find something in it, use searchSlack with \`in:<#${toRawSlackChannelId(chatChannelId)}>\` and the words: it searches with the asker's own access, so it covers the private channels they are in. To read it in full, they can connect their own Slack account: ${connect}`
                : String(refusal instanceof Error ? refusal.message : refusal)
            );
          }
          return await readAsAsker({
            channel: toRawSlackChannelId(chatChannelId),
            cursor,
            limit,
            oldest,
            threadTs: resolvedThreadTs,
            token,
          });
        }

        await joinChannel(chatChannelId);

        const result = await (resolvedThreadTs
          ? slack.fetchMessages(`${chatChannelId}:${resolvedThreadTs}`, {
              cursor,
              limit,
              oldest,
            })
          : slack.fetchChannelMessages(chatChannelId, {
              cursor,
              limit,
            })
        ).catch((error: unknown) => {
          // A bare thread_not_found read as "that thread is gone"; it is almost
          // always a channel or ts copied wrong from a link.
          if (String(error).includes('invalid_cursor')) {
            throw new Error(
              'invalid_cursor: a cursor is only valid as the exact nextCursor of the previous response for the SAME channel/thread. Omit it to start from the first page again.'
            );
          }
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
            // The thread being answered is already in the prompt as live
            // conversation; only another conversation's pings are stale.
            text:
              message.threadId === currentThreadId
                ? message.text
                : markStoredSelfMention(message.text),
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
          // Only messages after `after` are known to be in this read.
          ...(oldest
            ? {}
            : { note: `The newest ${limit} messages, oldest first.` }),
          threadTs: resolvedThreadTs ?? null,
        };
      }
    ),
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
// A Slack message ts (`1791695940.351679`); a real cursor is base64.
const MESSAGE_TS = /^\d+\.\d+$/;
const ASKER_THREAD_PAGE = 200;
const ASKER_THREAD_PAGES = 10;

/** A conversation read with the asker's own token: only theirs can be read. */
async function readAsAsker({
  channel,
  cursor,
  limit,
  oldest,
  threadTs,
  token,
}: {
  channel: string;
  cursor?: string;
  limit: number;
  oldest?: string;
  threadTs?: string;
  token: string;
}) {
  const client = new WebClient(token);
  // Slack pages a thread OLDEST first, so without a cursor the asker path walks
  // to its end and keeps the newest `limit`, as the bot path does — a poll for
  // fresh replies used to see only the thread's first page (#84). Channel
  // history comes newest first already.
  if (threadTs && !cursor) {
    let messages: z.infer<typeof askerMessageSchema>[] = [];
    let next: string | undefined;
    for (let page = 0; page < ASKER_THREAD_PAGES; page += 1) {
      const raw = await client.conversations.replies({
        channel,
        ...(next ? { cursor: next } : {}),
        limit: ASKER_THREAD_PAGE,
        ...(oldest ? { oldest } : {}),
        ts: threadTs,
      });
      const parsed = askerHistorySchema.parse(raw);
      messages = messages.concat(parsed.messages);
      next = parsed.response_metadata?.next_cursor || undefined;
      if (!next) {
        break;
      }
    }
    return askerResult({
      channel,
      messages: messages.slice(-limit),
      nextCursor: undefined,
      threadTs,
    });
  }
  const raw = threadTs
    ? await client.conversations.replies({
        channel,
        cursor,
        limit,
        ...(oldest ? { oldest } : {}),
        ts: threadTs,
      })
    : await client.conversations.history({
        channel,
        cursor,
        limit,
        ...(oldest ? { oldest } : {}),
      });
  const page = askerHistorySchema.parse(raw);
  return askerResult({
    channel,
    messages: page.messages,
    nextCursor: page.response_metadata?.next_cursor || undefined,
    threadTs,
  });
}

function askerResult({
  channel,
  messages,
  nextCursor,
  threadTs,
}: {
  channel: string;
  messages: z.infer<typeof askerMessageSchema>[];
  nextCursor: string | undefined;
  threadTs?: string;
}) {
  logger.info(
    { channel, count: messages.length, threadTs },
    "[readConversationHistory] read with the asker's own token"
  );
  return {
    channelId: channel,
    messages: messages.map((message) => ({
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
      text: markStoredSelfMention(message.text ?? ''),
      threadTs: message.thread_ts,
    })),
    nextCursor,
    readAs: 'the asker (their own Slack account)',
    threadTs: threadTs ?? null,
  };
}
