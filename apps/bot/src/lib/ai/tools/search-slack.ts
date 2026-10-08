import type { WebClient } from '@slack/web-api';
import { tool } from 'ai';
import { z } from 'zod';
import { recallActionToken } from '@/harness/action-tokens';
import type { Message } from '@/harness/types';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { askerSlackToken, slackAuthorizeUrl } from '@/lib/slack-oauth';
import { toLogError } from '@/lib/utils/error';

const actionTokenSchema = z.looseObject({
  action_token: z.string().min(1).optional(),
  assistant_thread: z
    .object({ action_token: z.string().min(1).optional() })
    .optional(),
});

// Per-hit text caps. A search page is 20 hits of FULL messages, and a tool
// result is written to the prompt cache once at 1.25x: seven searches over a
// thread of long answers came to ~66k tokens in one step (2026-10-07). The
// start of a hit is what says whether it is the right one; the rest is a read
// away (owner's call 2026-10-08).
const HIT_TEXT_CHARS = 800;
const CONTEXT_TEXT_CHARS = 300;

function capText(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [+${text.length - max} chars; full text: readConversationHistory with this channelId and threadTs = messageTs]`
    : text;
}

const contextMessageSchema = z
  .looseObject({
    text: z.string().nullish(),
    ts: z.string().nullish(),
    user_id: z.string().nullish(),
  })
  .transform((message) => ({
    text: capText(message.text ?? '', CONTEXT_TEXT_CHARS),
    ts: message.ts ?? undefined,
    userId: message.user_id ?? undefined,
  }));

const slackSearchResponseSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
  results: z
    .looseObject({
      messages: z
        .array(
          z
            .looseObject({
              author_name: z.string().nullish(),
              author_user_id: z.string().nullish(),
              channel_id: z.string().nullish(),
              channel_name: z.string().nullish(),
              content: z.string().nullish(),
              context_messages: z
                .looseObject({
                  after: z.array(contextMessageSchema).optional(),
                  before: z.array(contextMessageSchema).optional(),
                })
                .optional(),
              is_author_bot: z.boolean().optional(),
              message_ts: z.string().nullish(),
              permalink: z.string().nullish(),
              team_id: z.string().nullish(),
            })
            .transform((message) => ({
              authorName: message.author_name ?? undefined,
              authorUserId: message.author_user_id ?? undefined,
              channelId: message.channel_id ?? undefined,
              channelName: message.channel_name ?? undefined,
              content: capText(message.content ?? '', HIT_TEXT_CHARS),
              // Keep only the 2 context messages nearest the match on each side
              // (Slack returns ~5/5). Context is the dominant prompt-size driver
              // across agentic steps, so trimming it here slashes input-token
              // cost with no loss of the immediately-relevant surrounding thread.
              context: message.context_messages
                ? {
                    after: (message.context_messages.after ?? []).slice(0, 2),
                    before: (message.context_messages.before ?? []).slice(-2),
                  }
                : undefined,
              isAuthorBot: message.is_author_bot,
              messageTs: message.message_ts ?? undefined,
              permalink: message.permalink ?? undefined,
              teamId: message.team_id ?? undefined,
            }))
        )
        .optional(),
    })
    .optional(),
});

const MIN_SLACK_CURSOR_CHARS = 8;
// Which way in issued a page cursor (the assistant API's carry no tag).
const CURSOR_PREFIX = { account: 'account:', asker: 'user:' } as const;
// Room for the account's hits that the asker-membership filter drops.
const SEARCH_PAGE_SIZE = 20;

const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
const CHANNELS_PAGE = 1000;
const askerChannelCache = new Map<string, { at: number; ids: Set<string> }>();

/**
 * Every channel `userId` is in that the app can see: all their public ones,
 * and private ones the app shares with them. Cached 5 minutes.
 */
async function channelsOf(userId: string): Promise<Set<string>> {
  const cached = askerChannelCache.get(userId);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) {
    return new Set(cached.ids);
  }
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await slack.webClient.users.conversations({
      cursor,
      limit: CHANNELS_PAGE,
      types: 'public_channel,private_channel,mpim',
      user: userId,
    });
    for (const channel of page.channels ?? []) {
      if (channel.id) {
        ids.add(channel.id);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  askerChannelCache.set(userId, { at: Date.now(), ids });
  return new Set(ids);
}

// `search.messages` on a USER token — the second way in, and the one that does
// not expire mid-turn. Shaped to the same fields as the assistant path so the
// model cannot tell which one answered (it has no `context_messages`, which is
// the only thing it gives up).
const userSearchResponseSchema = z.looseObject({
  error: z.string().optional(),
  messages: z
    .looseObject({
      matches: z
        .array(
          z
            .looseObject({
              channel: z
                .looseObject({
                  id: z.string().optional(),
                  is_private: z.boolean().optional(),
                  name: z.string().optional(),
                })
                .optional(),
              // Slack sends `null`, not an absent key, for a hit with no
              // user (a bot or integration post) — and one such hit threw
              // away the whole page.
              permalink: z.string().nullish(),
              team: z.string().nullish(),
              text: z.string().nullish(),
              ts: z.string().nullish(),
              user: z.string().nullish(),
              username: z.string().nullish(),
            })
            .transform((match) => ({
              authorName: match.username ?? undefined,
              authorUserId: match.user ?? undefined,
              channelId: match.channel?.id,
              // A hit from a channel the SEARCHER is in says nothing about
              // whether anyone else can join it; kyto once called a private
              // channel public on the strength of a search hit.
              channelIsPrivate: match.channel?.is_private,
              channelName: match.channel?.name,
              content: capText(match.text ?? '', HIT_TEXT_CHARS),
              messageTs: match.ts ?? undefined,
              permalink: match.permalink ?? undefined,
              teamId: match.team ?? undefined,
            }))
        )
        .optional(),
      pagination: z
        .looseObject({ next_cursor: z.string().optional() })
        .optional(),
      paging: z.looseObject({ next_cursor: z.string().optional() }).optional(),
      total: z.number().optional(),
    })
    .optional(),
  ok: z.boolean(),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

export function searchSlackTool({ message }: { message: Message }) {
  return tool({
    description:
      "Search Slack messages for past conversations, decisions, links, or context outside the current thread — including a DM's own earlier history, since a fresh DM thread otherwise starts with no prior context by design. If the person connected their own Slack account it searches as them — every channel they can see, their DMs included. Otherwise, when they @mentioned kyto (or DMed it), Slack's search token for that message covers what they can see, DMs included — it expires ~2 minutes into the turn. Failing both, it searches as kyto's own Slack account and keeps only hits from channels the person is in (never anyone's DMs). For \"how many messages…\" questions use `totalMatches` when the result has it — Slack's own count for the whole query — instead of paging and counting; without it, say the number is only what search returned. Each hit's text is cut at 800 characters (context messages at 300), marked where cut; read the whole message with readConversationHistory when the cut part matters. To mean one person use `from:<@USERID>` with their id (getUser): a bare name like `from:twa` also matches everyone else whose name contains it. To find what a channel said about something, search `in:<#CHANNELID> keywords` — Slack filters server-side — rather than paging the channel's whole history.",
    inputSchema: z.object({
      cursor: z
        .string()
        .optional()
        .describe(
          'nextCursor from the previous searchSlack result, copied verbatim. Omit it for page 1; never make one up.'
        ),
      order: z
        .enum(['newest', 'oldest'])
        .optional()
        .describe(
          'Sort by time instead of relevance. "oldest" for first/earliest-N asks ("who posted first", "the first 10 messages"). Keep the same order when paging.'
        ),
      query: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'Search text. Supports Slack modifiers like from:@user, in:#channel, in:@user (DM), has:link, has:star, before:2026-01-01, after:2026-01-01, is:thread, filename:name, ext:filetype.'
        ),
    }),
    execute: async ({ cursor, order, query }) => {
      const userId = message.author.userId;
      const currentChannel = slack.channelIdFromThreadId(message.threadId);
      const parsedRaw = actionTokenSchema.safeParse(message.raw);
      const eventToken = parsedRaw.success
        ? (parsedRaw.data.action_token ??
          parsedRaw.data.assistant_thread?.action_token)
        : undefined;
      const actionToken =
        eventToken ??
        recallActionToken({ channel: currentChannel, ts: message.id });
      // #33: the user account's turn has no token of its own and borrows the
      // app's; this says whether that worked on a double mention.
      logger.debug(
        { fromEvent: Boolean(eventToken), hasToken: Boolean(actionToken) },
        '[searchSlack] action token'
      );

      const found = ({
        messages,
        nextCursor,
        totalMatches,
        via,
      }: {
        messages: unknown[];
        nextCursor: string | undefined;
        totalMatches?: number;
        via: string;
      }) => {
        logger.debug(
          { count: messages.length, query, totalMatches, via },
          '[searchSlack] complete'
        );
        return {
          messages,
          nextCursor,
          resultCount: messages.length,
          success: true,
          summary: `Slack search found ${messages.length} message${messages.length === 1 ? '' : 's'} on this page for "${query}".${ignoredCursor && cursor?.trim() ? ` "${cursor}" is not a cursor, so this is page 1 — page on with nextCursor, verbatim.` : ''}${totalMatches === undefined ? '' : ` Slack counts ${totalMatches} matches for the whole query — that is the answer to "how many", no paging needed.`}`,
          ...(totalMatches === undefined ? {} : { totalMatches }),
        };
      };
      const failed = (error: string) => ({
        error: `Slack search failed: ${error}`,
        success: false,
        summary: `Slack search failed for "${query}": ${error}`,
      });

      // Each API pages with its own cursor, and one handed to another is
      // invalid_cursor at best, so a cursor names the way in that issued it.
      const prefix = Object.values(CURSOR_PREFIX).find((tag) =>
        cursor?.startsWith(tag)
      );
      // gpt-6-luna fills in EVERY optional field, so on page 1 it sends "0",
      // "1", ":" or " " — 97 of 98 searches in its first week carried one, and
      // refusing them (or passing them to Slack as invalid_cursor) left kyto
      // with no search at all. Slack's cursors are long opaque strings, so a
      // short untagged one is a placeholder: search page 1 and say so.
      const ignoredCursor =
        cursor !== undefined &&
        !prefix &&
        cursor.trim().length < MIN_SLACK_CURSOR_CHARS;
      const realCursor = ignoredCursor ? undefined : cursor;
      const pageCursor = prefix ? realCursor?.slice(prefix.length) : realCursor;

      // `search.messages`, as the asker (their token) or as kyto's account.
      const searchMessages = async ({
        client,
        keep,
        tag,
        token,
      }: {
        client: WebClient;
        keep?: (channelId: string | undefined) => boolean;
        tag: string;
        token?: string;
      }) => {
        const response = userSearchResponseSchema.safeParse(
          await client.apiCall('search.messages', {
            count: SEARCH_PAGE_SIZE,
            // `*` opts into cursor pagination; without it Slack answers with
            // page numbers and never returns a next_cursor.
            cursor: (prefix === tag && pageCursor) || '*',
            query,
            ...(order
              ? {
                  sort: 'timestamp',
                  sort_dir: order === 'oldest' ? 'asc' : 'desc',
                }
              : {}),
            ...(token ? { token } : {}),
          })
        );
        if (!response.success) {
          logger.warn(
            { issues: response.error.issues.slice(0, 3), query },
            '[searchSlack] unexpected search response shape'
          );
          return {
            error: 'unexpected response from Slack',
            ok: false as const,
          };
        }
        const parsed = response.data;
        if (!parsed.ok) {
          return { error: parsed.error ?? 'unknown', ok: false as const };
        }
        const matches = parsed.messages?.matches ?? [];
        // Slack puts this cursor under `messages`, not `response_metadata`
        // — read from the wrong place, a user search never had a page 2.
        const next =
          parsed.messages?.paging?.next_cursor ??
          parsed.messages?.pagination?.next_cursor ??
          parsed.response_metadata?.next_cursor;
        return {
          ok: true as const,
          // Slack's count for the whole query. Only meaningful unfiltered:
          // past `keep` it would count channels the asker isn't in.
          total: keep ? undefined : parsed.messages?.total,
          matches: keep
            ? matches.filter(({ channelId }) => keep(channelId))
            : matches,
          next: next ? `${tag}${next}` : undefined,
        };
      };

      // 1. The asker's own token: exactly their view, their DMs included
      //    (`search:read` covers DMs; a bot token never can).
      const ownToken = await askerSlackToken(userId);
      if (ownToken && (!prefix || prefix === CURSOR_PREFIX.asker)) {
        const result = await searchMessages({
          client: slack.webClient,
          tag: CURSOR_PREFIX.asker,
          token: ownToken,
        });
        if (!result.ok) {
          logger.warn(
            { error: result.error, query },
            '[searchSlack] search as the asker failed'
          );
          return failed(result.error);
        }
        return found({
          messages: result.matches,
          nextCursor: result.next,
          totalMatches: result.total,
          via: 'asker token',
        });
      }

      // 2. Slack's per-mention assistant token: the ASKER's view, searched
      //    by the app — its private/group-DM/DM scopes are granted, but Slack
      //    searches public channels only unless `channel_types` says
      //    otherwise, and kyto never said, which is why DM content came back
      //    empty (PR #32). Gone ~2 minutes into the turn.
      // It has no time sort, so an ordered search goes straight to step 3.
      if (actionToken && !prefix && !order) {
        const parsedResponse = slackSearchResponseSchema.safeParse(
          await slack.webClient
            .apiCall('assistant.search.context', {
              action_token: actionToken,
              channel_types: [
                'public_channel',
                'private_channel',
                'mpim',
                'im',
              ],
              content_types: ['messages'],
              cursor: pageCursor,
              include_context_messages: true,
              limit: 10,
              query,
            })
            .catch((error: unknown) => ({
              error: toLogError(error).err.message,
              ok: false,
            }))
        );
        const response = parsedResponse.success
          ? parsedResponse.data
          : undefined;
        const messages = response?.results?.messages ?? [];
        // An empty FIRST page falls through to kyto's account too: cheap, and
        // the assistant search has missed what plain search finds.
        if (response?.ok && (messages.length > 0 || pageCursor)) {
          return found({
            messages,
            nextCursor: response.response_metadata?.next_cursor || undefined,
            via: 'action token',
          });
        }
        if (pageCursor) {
          return failed(
            response?.error === 'invalid_cursor'
              ? 'that cursor has expired (the search token behind it lasts ~2 minutes). Re-run the query without a cursor to start again at page 1.'
              : (response?.error ?? 'unknown')
          );
        }
        logger.warn(
          { error: response?.ok ? 'no results' : response?.error, query },
          "[searchSlack] assistant search gave nothing; trying kyto's account"
        );
      }

      // 3. kyto's user account. It sees every public channel and the private
      //    channels and DMs IT is in — so only hits from conversations the
      //    ASKER is in are kept (owner's call, 2026-10-05), or anyone could
      //    search a private channel, or kyto's DMs with other people, through
      //    it. Fails closed: a membership lookup that errors keeps nothing.
      if (
        slack.userAccountId &&
        (!prefix || prefix === CURSOR_PREFIX.account)
      ) {
        try {
          const askerChannels = await channelsOf(userId);
          askerChannels.add(currentChannel);
          const result = await searchMessages({
            client: slack.requireUserAccountClient(),
            keep: (channelId) =>
              channelId !== undefined && askerChannels.has(channelId),
            tag: CURSOR_PREFIX.account,
          });
          if (result.ok) {
            return found({
              messages: result.matches,
              nextCursor: result.next,
              via: "kyto's account",
            });
          }
          logger.warn(
            { error: result.error, query },
            "[searchSlack] search as kyto's account failed"
          );
        } catch (error) {
          logger.warn(
            { ...toLogError(error), query },
            "[searchSlack] search as kyto's account failed"
          );
        }
        return failed("kyto's account search failed");
      }

      const connect = slackAuthorizeUrl(userId);
      return {
        error: connect
          ? `Slack search is unavailable right now. The person can connect their own Slack account, which also lets kyto search their DMs: ${connect}`
          : 'Slack search is unavailable right now.',
        success: false,
        summary:
          "Could not search Slack: no assistant search token this turn, and kyto's user account is not configured.",
      };
    },
  });
}
