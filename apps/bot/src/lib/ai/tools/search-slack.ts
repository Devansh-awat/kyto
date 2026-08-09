import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { Message } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { slackAuthorizeUrl, userSlackToken } from '@/lib/slack-oauth';

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
              channelName: match.channel?.name,
              content: match.text ?? '',
              messageTs: match.ts,
              permalink: match.permalink,
              teamId: match.team,
            }))
        )
        .optional(),
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
      "Search Slack messages for past conversations, decisions, links, or context outside the current thread — including a DM's own earlier history, since a fresh DM thread otherwise starts with no prior context by design. Runs with the requesting user's own Slack access, so it reaches private channels and DMs that user is in, not just public channels. Supports normal Slack search modifiers in the query: from:@user, from:me, to:@user, in:#channel, in:@user (DM), on:YYYY-MM-DD, before:YYYY-MM-DD, after:YYYY-MM-DD, during:month-or-YYYY-MM, has:link, has:star, has:pin, has::emoji_name: (reaction), is:thread, is:dm, is:external, filename:name, ext:filetype. Prefers Slack's assistant search token, which expires ~2 minutes into the turn, and falls back to the user's own connected Slack account when it has gone stale — so a late search still works if they have connected one, and is worth retrying once.",
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
      const parsedRaw = actionTokenSchema.safeParse(message.raw);
      const actionToken = parsedRaw.success
        ? (parsedRaw.data.action_token ??
          parsedRaw.data.assistant_thread?.action_token)
        : undefined;

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

      // The user's own token, which does not expire. Resolved up front because
      // it decides what to do when the assistant token is missing or stale.
      const ownToken = await searcherToken(userId);

      const searchAsUser = async (token: string, why: string) => {
        const parsed = userSearchResponseSchema.parse(
          await slack.webClient.apiCall('search.messages', {
            count: 10,
            // `*` opts into cursor pagination; without it Slack answers with
            // page numbers and never returns a next_cursor.
            cursor: cursor ?? '*',
            query,
            token,
          })
        );
        if (!parsed.ok) {
          const error = parsed.error ?? 'unknown';
          logger.warn(
            { error, query, why },
            '[searchSlack] user search failed'
          );
          return {
            error: `Slack search failed: ${error}`,
            success: false,
            summary: `Slack search failed for "${query}": ${error}`,
          };
        }
        logger.info({ query, why }, '[searchSlack] searched as the user');
        return found(
          parsed.messages?.matches ?? [],
          parsed.response_metadata?.next_cursor || undefined,
          'user token'
        );
      };

      if (!actionToken) {
        if (ownToken) {
          return await searchAsUser(ownToken, 'no action token in this turn');
        }
        // Neither way in. The action token only arrives when kyto is mentioned;
        // the grant is the durable fix, so offer it rather than just refusing.
        const connect = slackAuthorizeUrl(userId);
        return {
          error: connect
            ? `Slack search needs either an explicit @kyto mention (Slack only issues its short-lived search token then) or the user's own connected Slack account. They can connect one here: ${connect}`
            : 'Slack search requires the user to explicitly ping/mention Kyto so Slack provides an assistant search token.',
          success: false,
          summary:
            'Could not search Slack: this turn carried no assistant search token and this user has not connected their Slack account.',
        };
      }

      const parsedResponse = slackSearchResponseSchema.parse(
        await slack.webClient.apiCall('assistant.search.context', {
          action_token: actionToken,
          content_types: ['messages'],
          cursor,
          include_context_messages: true,
          limit: 10,
          query,
        })
      );

      if (!parsedResponse.ok) {
        const error = parsedResponse.error ?? 'unknown';
        logger.warn({ error, query }, '[searchSlack] search failed');
        // The assistant action token expires ~2 minutes into a turn, so any
        // search after a few tool calls used to fail outright with
        // `invalid_action_token`. The user's own token has no such deadline —
        // retry on it rather than telling them to ask again.
        if (ownToken) {
          return await searchAsUser(ownToken, error);
        }
        const connect = slackAuthorizeUrl(userId);
        return {
          error:
            error === 'invalid_action_token' && connect
              ? `Slack search failed: the assistant search token for this turn expired (it only lasts ~2 minutes). Connecting a Slack account removes that deadline: ${connect}`
              : `Slack search failed: ${error}`,
          success: false,
          summary: `Slack search failed for "${query}": ${error}`,
        };
      }

      return found(
        parsedResponse.results?.messages ?? [],
        parsedResponse.response_metadata?.next_cursor || undefined,
        'action token'
      );
    },
  });
}
