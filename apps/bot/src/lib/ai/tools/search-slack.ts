import { tool } from 'ai';
import type { Message } from 'chat';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';

// Per Slack's assistant.search.context docs, a user reference in a query
// modifier (in:/from:/to:/with:/creator:) must be the angle-bracket mention
// form <@U12345> — a bare @U12345 (no brackets) or a bare U12345 (no @ at
// all) is silently ignored rather than erroring, so the search just runs as
// if that modifier were never given. This was the actual root cause of DM
// lookups returning 0 results even for confirmed-existing history: earlier
// attempts fixed the modifier NAME (in: vs to:) and added an "@", but never
// wrapped the id in angle brackets. Repair it here rather than relying on the
// model to always remember the exact bracket syntax.
const USER_REF_MODIFIER =
  /\b(in|from|to|with|creator):<?@?([UW][A-Z0-9]{6,})>?/gi;

function normalizeSearchQuery(query: string): string {
  return query.replace(USER_REF_MODIFIER, '$1:<@$2>');
}

// content_types defaults to 'messages' but channel_types has its own
// independent default that appears to exclude DMs/group-DMs unless listed
// explicitly — pass all four so a query can reach any conversation the
// search:read.* bot scopes already grant access to (public/private channels
// and 1:1/group DMs).
const CHANNEL_TYPES = 'public_channel,private_channel,mpim,im';

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

export function searchSlackTool({ message }: { message: Message }) {
  return tool({
    description:
      "Search Slack messages for past conversations, decisions, links, or context outside the current thread — including a DM's own earlier history, since a fresh DM thread otherwise starts with no prior context by design. Runs with the requesting user's own Slack access, so it reaches private channels and DMs that user is in, not just public channels. Supports normal Slack search modifiers in the query: from:@user, from:me, to:@user, in:#channel, in:@user (DM), on:YYYY-MM-DD, before:YYYY-MM-DD, after:YYYY-MM-DD, during:month-or-YYYY-MM, has:link, has:star, has:pin, has::emoji_name: (reaction), is:thread, is:dm, is:external, filename:name, ext:filetype. Uses an assistant action token that expires ~2 minutes into the turn, so run this early rather than after other work.",
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
          'Search text. Supports Slack modifiers like from:@user, in:#channel, in:@user (DM), has:link, has:star, before:2026-01-01, after:2026-01-01, is:thread, filename:name, ext:filetype. To search a DM (including a DM with a bot), use in:@user ALONE with the other party — do NOT pair it with to:@user, which only means "mentioned this user" inside a channel search and does nothing useful for DMs. When you only have a raw user id (not a handle), just write it plainly, e.g. in:@U09ASUK57K8 — this tool automatically converts it to the angle-bracket form Slack actually requires (in:<@U09ASUK57K8>) before searching.'
        ),
    }),
    execute: async ({ cursor, query }) => {
      const parsedRaw = actionTokenSchema.safeParse(message.raw);
      const actionToken = parsedRaw.success
        ? (parsedRaw.data.action_token ??
          parsedRaw.data.assistant_thread?.action_token)
        : undefined;

      if (!actionToken) {
        return {
          error:
            'Slack search requires the user to explicitly ping/mention Kyto so Slack provides an assistant search token.',
          success: false,
          summary:
            'Could not search Slack because this turn did not include an assistant search token. Ask the user to explicitly mention Kyto.',
        };
      }

      const normalizedQuery = normalizeSearchQuery(query);
      if (normalizedQuery !== query) {
        logger.debug(
          { normalizedQuery, query },
          '[searchSlack] normalized user reference to angle-bracket form'
        );
      }

      const parsedResponse = slackSearchResponseSchema.parse(
        await slack.webClient.apiCall('assistant.search.context', {
          action_token: actionToken,
          channel_types: CHANNEL_TYPES,
          content_types: ['messages'],
          cursor,
          include_context_messages: true,
          limit: 10,
          query: normalizedQuery,
        })
      );
      const messages = parsedResponse.results?.messages ?? [];
      const nextCursor =
        parsedResponse.response_metadata?.next_cursor || undefined;

      if (!parsedResponse.ok) {
        const error = parsedResponse.error ?? 'unknown';
        logger.warn(
          { error, query: normalizedQuery },
          '[searchSlack] search failed'
        );
        return {
          error: `Slack search failed: ${error}`,
          success: false,
          summary: `Slack search failed for "${query}": ${error}`,
        };
      }

      logger.debug(
        { count: messages.length, query: normalizedQuery },
        '[searchSlack] complete'
      );
      return {
        messages,
        nextCursor,
        resultCount: messages.length,
        success: true,
        summary: `Slack search found ${messages.length} message${messages.length === 1 ? '' : 's'} for "${query}".`,
      };
    },
  });
}
