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
  dmSourceNote,
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
      since: z
        .string()
        .optional()
        .describe(
          'CHANNEL history only: a time window like "14d", "36h", "2w" or a date (2026-11-01, UTC). Pages the channel back to then in this one call (up to 1000 messages) and says whether it got all of it and the range it covered. Instead of cursor-paging by hand.'
        ),
      includeThreads: z
        .boolean()
        .optional()
        .describe(
          'With `since`: also read the replies of the threads in the window (up to 60 threads), each reply placed after its thread starter.'
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
        includeThreads,
        limit,
        permalink,
        since,
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
        // The model sent only {limit, after} twice in one turn, the thread it
        // meant in context but never named (#56): nothing named means THIS
        // thread (or, with just a threadTs, this channel).
        const current = slack.decodeThreadId(currentThreadId);
        const named = Boolean(link || channelId || decodedThread);
        const resolvedChannelId =
          link?.channelId ||
          channelId ||
          (decodedThread ? `slack:${decodedThread.channel}` : undefined) ||
          `slack:${current.channel}`;
        const resolvedThreadTs =
          link?.threadTs ||
          threadTs ||
          decodedThread?.threadTs ||
          (named || since ? undefined : current.threadTs) ||
          undefined;
        // A message ts passed as the cursor came back `invalid_cursor` four times
        // in one turn, each a 3-4s round trip, and the model kept guessing (#65).
        if (cursor && MESSAGE_TS.test(cursor)) {
          throw new Error(
            `cursor ${cursor} is a message timestamp, not a pagination cursor. Pass the nextCursor from the previous response, or omit cursor and pass the thread's ts as threadTs to start from its first page.`
          );
        }

        const sinceTs = since?.trim() ? parseSince(since) : undefined;
        if (sinceTs && resolvedThreadTs) {
          throw new Error(
            '`since` windows a CHANNEL; for a thread pass `after` (a message ts) or just limit.'
          );
        }
        const oldest = after?.trim() || sinceTs || undefined;
        if (after?.trim() && !MESSAGE_TS.test(after.trim())) {
          throw new Error(
            `after must be a message ts like 1791695940.351679, not ${after.trim()}.`
          );
        }

        const chatChannelId = toChatSlackChannelId(resolvedChannelId);
        const dmNote = await dmSourceNote({
          channelIds: [toRawSlackChannelId(chatChannelId)],
          currentThreadId,
        });
        const dmSource = dmNote ? { dmSource: dmNote } : {};

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
          return {
            ...(await readAsAsker({
              channel: toRawSlackChannelId(chatChannelId),
              cursor,
              limit,
              oldest,
              threadTs: resolvedThreadTs,
              token,
            })),
            ...dmSource,
          };
        }

        if (sinceTs && oldest) {
          return {
            ...(await readWindow({
              channelId: chatChannelId,
              currentThreadId,
              includeThreads: Boolean(includeThreads),
              oldest,
            })),
            ...dmSource,
          };
        }

        const result = await (resolvedThreadTs
          ? slack.fetchMessages(`${chatChannelId}:${resolvedThreadTs}`, {
              cursor,
              limit,
              oldest,
            })
          : slack.fetchChannelMessages(chatChannelId, {
              cursor,
              limit,
              oldest,
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
          ...dmSource,
        };
      }
    ),
  });
}

const askerMessageSchema = z.looseObject({
  // A bot/app card's content lives here, not in `text` (#146).
  attachments: z
    .array(
      z.looseObject({
        fallback: z.string().optional(),
        pretext: z.string().optional(),
        text: z.string().optional(),
        title: z.string().optional(),
      })
    )
    .optional(),
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

/** Card content (GitHub, CI, …) out of a raw Slack message's attachments. */
function askerCardText(
  attachments: z.infer<typeof askerMessageSchema>['attachments']
): string {
  if (!attachments) {
    return '';
  }
  const cards: string[] = [];
  for (const card of attachments) {
    const pieces = [card.pretext, card.title, card.text].filter(
      (piece): piece is string => Boolean(piece?.trim())
    );
    const raw = pieces.length > 0 ? pieces.join('\n') : (card.fallback ?? '');
    if (raw.trim()) {
      cards.push(raw.trim());
    }
  }
  return cards.join('\n\n');
}
const askerHistorySchema = z.looseObject({
  messages: z.array(askerMessageSchema).default([]),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

const MS_PER_SECOND = 1000;
const SECONDS_PER_UNIT = {
  d: 86_400,
  h: 3600,
  m: 60,
  w: 604_800,
} as const;
// A busy channel's last two weeks were 1000+ messages and 140+ threads, read
// with 11 calls and a stated gap (#201). One call pages the window, bounded.
const WINDOW_PAGE = 200;
const WINDOW_MAX_MESSAGES = 1000;
const WINDOW_MAX_THREADS = 60;
const WINDOW_THREAD_REPLIES = 200;
const WINDOW_THREAD_CONCURRENCY = 5;
const WINDOW_TEXT_MAX = 1500;

/** "14d" / "36h" / "2w" / "90m" or a UTC date, as a Slack ts to read from. */
function parseSince(value: string): string {
  const text = value.trim().toLowerCase();
  const span = /^(\d+)\s*(d|h|m|w)$/.exec(text);
  let seconds: number;
  if (span) {
    const unit = span[2] as keyof typeof SECONDS_PER_UNIT;
    seconds =
      Date.now() / MS_PER_SECOND - Number(span[1]) * SECONDS_PER_UNIT[unit];
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    seconds = Date.parse(`${text}T00:00:00Z`) / MS_PER_SECOND;
  } else {
    seconds = Number.NaN;
  }
  if (!Number.isFinite(seconds)) {
    throw new Error(
      `since must be a span like 14d, 36h or 2w, or a date like 2026-11-01, not ${value}.`
    );
  }
  return seconds.toFixed(6);
}

type WindowMessage = Awaited<
  ReturnType<typeof slack.fetchChannelMessages>
>['messages'][number];

/** A channel back to `oldest`, and optionally the replies of its threads. */
async function readWindow({
  channelId,
  currentThreadId,
  includeThreads,
  oldest,
}: {
  channelId: string;
  currentThreadId: string;
  includeThreads: boolean;
  oldest: string;
}) {
  const roots: WindowMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await slack.fetchChannelMessages(channelId, {
      cursor,
      limit: WINDOW_PAGE,
      oldest,
    });
    roots.push(...page.messages);
    cursor = page.nextCursor;
  } while (cursor && roots.length < WINDOW_MAX_MESSAGES);
  // Slack pages newest first; a cursor left over means older messages in the
  // window were not read.
  const historyComplete = !cursor;
  roots.sort((a, b) => Number(a.id) - Number(b.id));

  const withReplies = includeThreads
    ? roots.filter((root) => Number(root.raw.reply_count) > 0)
    : [];
  // Newest threads first: if the budget runs out, the recent ones are kept.
  const wanted = withReplies.slice(-WINDOW_MAX_THREADS);
  const replies = new Map<string, WindowMessage[]>();
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const root = wanted[next++];
      if (!root) {
        return;
      }
      const thread = await slack
        .fetchMessages(`${channelId}:${root.id}`, {
          limit: WINDOW_THREAD_REPLIES,
        })
        .catch(() => undefined);
      if (thread) {
        replies.set(
          root.id,
          thread.messages.filter((message) => message.id !== root.id)
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: WINDOW_THREAD_CONCURRENCY }, () => worker())
  );

  const shape = (message: WindowMessage) => ({
    id: message.id,
    threadId: message.threadId,
    text: (message.threadId === currentThreadId
      ? message.text
      : markStoredSelfMention(message.text)
    ).slice(0, WINDOW_TEXT_MAX),
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
      isBot: message.author.isBot,
    },
    dateSent: message.metadata.dateSent?.toISOString(),
    attachments: (message.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      url: attachment.url,
    })),
  });
  const messages = roots.flatMap((root) => [
    shape(root),
    ...(replies.get(root.id) ?? []).map(shape),
  ]);
  const threadsRead = replies.size;
  const covered = {
    from: roots[0]?.metadata.dateSent?.toISOString(),
    to: roots.at(-1)?.metadata.dateSent?.toISOString(),
  };
  return {
    channelId,
    messages,
    complete:
      historyComplete &&
      (!includeThreads || threadsRead === withReplies.length),
    covered,
    note: `${roots.length} top-level messages since ${new Date(Number(oldest) * MS_PER_SECOND).toISOString()}, oldest first${historyComplete ? '' : `; STOPPED at the ${WINDOW_MAX_MESSAGES}-message cap, so only the newest part of the window was read (from ${covered.from}). Pass a later \`since\` to read the rest by pieces`}. ${includeThreads ? `Replies read for ${threadsRead} of ${withReplies.length} threads${threadsRead < withReplies.length ? ' (the newest ones)' : ''}; texts cut at ${WINDOW_TEXT_MAX} characters.` : 'Thread replies not included (includeThreads: true adds them).'}`,
    threadTs: null,
  };
}
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
      text: markStoredSelfMention(
        [message.text ?? '', askerCardText(message.attachments)]
          .filter(Boolean)
          .join('\n\n')
      ),
      threadTs: message.thread_ts,
    })),
    nextCursor,
    readAs: 'the asker (their own Slack account)',
    threadTs: threadTs ?? null,
  };
}
