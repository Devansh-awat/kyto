import { tool } from 'ai';
import type { Message } from 'chat';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';

// A Slack user/bot id (U... or W...) used after in:/from:/to: without a
// leading "@" is silently ignored by Slack's search parser — it isn't
// recognized as a user reference at all, so the search runs as if that
// modifier were never given and returns 0 results with no error. Observed:
// the model wrote `in:U09ASUK57K8` while looking up a DM and got zero
// results even though the DM existed. Repair it here instead of relying on
// the model to always remember the "@" — insert it whenever a bare user id
// follows one of these modifiers.
const BARE_USER_ID_MODIFIER = /\b(in|from|to):(?!@)([UW][A-Z0-9]{6,})\b/gi;
const ID_MODIFIER = /\b(in|from|to):@([UW][A-Z0-9]{6,})\b/gi;

function normalizeSearchQuery(query: string): string {
  return query.replace(BARE_USER_ID_MODIFIER, '$1:@$2');
}

const userInfoSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  user: z.looseObject({ name: z.string().optional() }).optional(),
});

/** Resolve each unique user id in in:@/from:@/to:@ modifiers to its Slack
 * username (e.g. "tanjim"), returning a query with ids substituted for
 * handles. Slack's search backend appears to key user references by handle,
 * not raw id — an id-based modifier can silently match nothing even though
 * the "@" prefix is present and correct. Returns undefined if no id modifiers
 * are present or none could be resolved (so the caller can skip the retry). */
async function queryWithResolvedHandles(
  query: string
): Promise<string | undefined> {
  const ids = [...query.matchAll(ID_MODIFIER)].map((match) => match[2]);
  if (ids.length === 0) {
    return;
  }
  const uniqueIds = [...new Set(ids)];
  const resolved = await Promise.all(
    uniqueIds.map(async (id) => {
      const info = userInfoSchema.parse(
        await slack.webClient
          .apiCall('users.info', { user: id })
          .catch(() => ({ ok: false }))
      );
      return [id, info.ok ? info.user?.name : undefined] as const;
    })
  );
  const handleById = new Map(
    resolved.filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
  if (handleById.size === 0) {
    return;
  }
  return query.replace(
    ID_MODIFIER,
    (fullMatch, modifier: string, id: string) => {
      const handle = handleById.get(id);
      return handle ? `${modifier}:@${handle}` : fullMatch;
    }
  );
}

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
          'Search text. Supports Slack modifiers like from:@user, in:#channel, in:@user (DM), has:link, has:star, before:2026-01-01, after:2026-01-01, is:thread, filename:name, ext:filetype. To search a DM (including a DM with a bot), use in:@user ALONE with the other party — do NOT pair it with to:@user, which only means "mentioned this user" inside a channel search and does nothing useful for DMs. The @ is REQUIRED even when using a raw user id instead of a handle, e.g. in:@U09ASUK57K8 — in:U09ASUK57K8 without the @ is silently ignored and returns 0 results. If you only have a raw user id, use it directly (in:@U09ASUK57K8) — this tool automatically retries with the resolved @handle if that comes back empty, since Slack search sometimes only matches on the handle.'
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
          '[searchSlack] normalized bare user id in query'
        );
      }

      const runSearch = async (searchQuery: string) =>
        slackSearchResponseSchema.parse(
          await slack.webClient.apiCall('assistant.search.context', {
            action_token: actionToken,
            content_types: ['messages'],
            cursor,
            include_context_messages: true,
            limit: 10,
            query: searchQuery,
          })
        );

      let finalQuery = normalizedQuery;
      let parsedResponse = await runSearch(normalizedQuery);

      if (
        parsedResponse.ok &&
        (parsedResponse.results?.messages ?? []).length === 0
      ) {
        const handleQuery = await queryWithResolvedHandles(normalizedQuery);
        if (handleQuery && handleQuery !== normalizedQuery) {
          const retryResponse = await runSearch(handleQuery);
          logger.debug(
            {
              handleQuery,
              originalQuery: normalizedQuery,
              retryCount: retryResponse.results?.messages?.length ?? 0,
            },
            '[searchSlack] retried with resolved username after 0 results'
          );
          if (
            retryResponse.ok &&
            (retryResponse.results?.messages ?? []).length > 0
          ) {
            finalQuery = handleQuery;
            parsedResponse = retryResponse;
          }
        }
      }

      const messages = parsedResponse.results?.messages ?? [];
      const nextCursor =
        parsedResponse.response_metadata?.next_cursor || undefined;

      if (!parsedResponse.ok) {
        const error = parsedResponse.error ?? 'unknown';
        logger.warn(
          { error, query: finalQuery },
          '[searchSlack] search failed'
        );
        return {
          error: `Slack search failed: ${error}`,
          success: false,
          summary: `Slack search failed for "${query}": ${error}`,
        };
      }

      logger.debug(
        { count: messages.length, query: finalQuery },
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
