import type { WebClient } from '@slack/web-api';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { recallActionToken } from '@/harness/action-tokens';
import type { Message } from '@/harness/types';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { slackAuthorizeUrl, userSlackToken } from '@/lib/slack-oauth';
import { toLogError } from '@/lib/utils/error';

const actionTokenSchema = z.looseObject({
  action_token: z.string().min(1).optional(),
  assistant_thread: z
    .object({ action_token: z.string().min(1).optional() })
    .optional(),
});

const contextMessageSchema = z
  .looseObject({
    text: z.string().optional(),
    ts: z.string().optional(),
    user_id: z.string().optional(),
  })
  .transform((message) => ({
    text: message.text ?? '',
    ts: message.ts,
    userId: message.user_id,
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
              author_name: z.string().optional(),
              author_user_id: z.string().optional(),
              channel_id: z.string().optional(),
              channel_name: z.string().optional(),
              content: z.string().optional(),
              context_messages: z
                .looseObject({
                  after: z.array(contextMessageSchema).optional(),
                  before: z.array(contextMessageSchema).optional(),
                })
                .optional(),
              is_author_bot: z.boolean().optional(),
              message_ts: z.string().optional(),
              permalink: z.string().optional(),
              team_id: z.string().optional(),
            })
            .transform((message) => ({
              authorName: message.author_name,
              authorUserId: message.author_user_id,
              channelId: message.channel_id,
              channelName: message.channel_name,
              content: message.content ?? '',
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
              messageTs: message.message_ts,
              permalink: message.permalink,
              teamId: message.team_id,
            }))
        )
        .optional(),
    })
    .optional(),
});

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
              permalink: z.string().optional(),
              team: z.string().optional(),
              text: z.string().optional(),
              ts: z.string().optional(),
              user: z.string().optional(),
              username: z.string().optional(),
            })
            .transform((match) => ({
              authorName: match.username,
              authorUserId: match.user,
              channelId: match.channel?.id,
              // A hit from a channel the SEARCHER is in says nothing about
              // whether anyone else can join it; kyto once called a private
              // channel public on the strength of a search hit.
              channelIsPrivate: match.channel?.is_private,
              channelName: match.channel?.name,
              content: match.text ?? '',
              messageTs: match.ts,
              permalink: match.permalink,
              teamId: match.team,
            }))
        )
        .optional(),
      pagination: z
        .looseObject({ next_cursor: z.string().optional() })
        .optional(),
      paging: z.looseObject({ next_cursor: z.string().optional() }).optional(),
    })
    .optional(),
  ok: z.boolean(),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

/**
 * The searching user's own Slack token, if kyto has one.
 *
 * Their per-user OAuth grant first (`search:read`, granted by them, in their
 * name). The owner also has a token in the environment from before grants
 * existed; using it FOR HIM is the same principal, so it stays as a fallback —
 * but it is never used for anyone else, or kyto would be searching one person's
 * private channels on another person's behalf.
 */
async function searcherToken(userId: string): Promise<string | null> {
  const granted = await userSlackToken(userId).catch(() => null);
  if (granted) {
    return granted;
  }
  return userId === env.OWNER_USER_ID ? (env.SLACK_USER_TOKEN ?? null) : null;
}

export function searchSlackTool({ message }: { message: Message }) {
  return tool({
    description:
      "Search Slack messages for past conversations, decisions, links, or context outside the current thread — including a DM's own earlier history, since a fresh DM thread otherwise starts with no prior context by design. If the person connected their own Slack account it searches as them — every channel they can see, their DMs included. Otherwise, when they @mentioned kyto (or DMed it), Slack's search token for that message covers what they can see, DMs included — it expires ~2 minutes into the turn. Failing both, it searches as kyto's own Slack account and keeps only hits from channels the person is in (never anyone's DMs).",
    inputSchema: z.object({
      cursor: z
        .string()
        .min(1)
        .optional()
        .describe('Cursor from a previous Slack search result page.'),
      query: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'Search text. Supports Slack modifiers like from:@user, in:#channel, in:@user (DM), has:link, has:star, before:2026-01-01, after:2026-01-01, is:thread, filename:name, ext:filetype.'
        ),
    }),
    execute: async ({ cursor, query }) => {
      const userId = message.author.userId;
      const currentChannel = slack.channelIdFromThreadId(message.threadId);
      const parsedRaw = actionTokenSchema.safeParse(message.raw);
      const actionToken =
        (parsedRaw.success
          ? (parsedRaw.data.action_token ??
            parsedRaw.data.assistant_thread?.action_token)
          : undefined) ??
        recallActionToken({ channel: currentChannel, ts: message.id });

      const found = (
        messages: unknown[],
        nextCursor: string | undefined,
        via: string
      ) => {
        logger.debug(
          { count: messages.length, query, via },
          '[searchSlack] complete'
        );
        return {
          messages,
          nextCursor,
          resultCount: messages.length,
          success: true,
          summary: `Slack search found ${messages.length} message${messages.length === 1 ? '' : 's'} for "${query}".`,
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
      const pageCursor = prefix ? cursor?.slice(prefix.length) : cursor;

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
        const parsed = userSearchResponseSchema.parse(
          await client.apiCall('search.messages', {
            count: SEARCH_PAGE_SIZE,
            // `*` opts into cursor pagination; without it Slack answers with
            // page numbers and never returns a next_cursor.
            cursor: (prefix === tag && pageCursor) || '*',
            query,
            ...(token ? { token } : {}),
          })
        );
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
          matches: keep
            ? matches.filter(({ channelId }) => keep(channelId))
            : matches,
          next: next ? `${tag}${next}` : undefined,
        };
      };

      // 1. The asker's own token: exactly their view, their DMs included
      //    (`search:read` covers DMs; a bot token never can).
      const ownToken = await searcherToken(userId);
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
        return found(result.matches, result.next, 'asker token');
      }

      // 2. Slack's per-mention assistant token: the ASKER's view, searched
      //    by the app — its private/group-DM/DM scopes are granted, but Slack
      //    searches public channels only unless `channel_types` says
      //    otherwise, and kyto never said, which is why DM content came back
      //    empty (PR #32). Gone ~2 minutes into the turn.
      if (actionToken && !prefix) {
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
          return found(
            messages,
            response.response_metadata?.next_cursor || undefined,
            'action token'
          );
        }
        if (pageCursor) {
          return failed(response?.error ?? 'unknown');
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
            return found(result.matches, result.next, "kyto's account");
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
