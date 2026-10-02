import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const okSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

// 'user' used to mean the OWNER: the user-account persona read it as "my
// own user account" and pinned under the owner's name, then told people it
// was its own token. Each actor is now named for whose name the pin shows.
const actAsSchema = z
  .enum(['app', 'account', 'owner'])
  .optional()
  .describe(
    "Whose name the pin shows: 'app' = the kyto app (bot); 'account' = kyto's own Slack user account (only in channels it has joined); 'owner' = the OWNER's personal account, never kyto — only when the owner triggered this turn AND explicitly asked for it to be under their name. Defaults to whichever kyto you are answering as."
  );

type Actor = 'app' | 'account' | 'owner';

const ACTOR_LABEL: Record<Actor, string> = {
  account: "kyto's user account",
  app: 'the kyto app',
  owner: "the owner's personal account",
};

const channelIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Target Slack channel id (e.g. C0123ABC). Defaults to the current channel.'
  );

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

/** Resolve the channel to act on, preferring an explicit id over the thread. */
function resolveChannel(
  thread: Thread,
  channelId?: string
): { ok: true; channelId: string } | { ok: false; error: string } {
  const resolved = channelId ?? channelIdFromThread(thread);
  if (!resolved) {
    return { error: 'Could not resolve a Slack channel.', ok: false };
  }
  return { channelId: resolved, ok: true };
}

/**
 * Owner gate for "act as the owner". The tools are registered for everyone, but
 * `as: 'user'` must never be honored for a non-owner — re-check here as
 * defense-in-depth so a misconfiguration can't let one user act as another.
 */
function ownerUserToken(authorUserId: string): string | null {
  if (
    env.SLACK_USER_TOKEN &&
    env.OWNER_USER_ID &&
    authorUserId === env.OWNER_USER_ID
  ) {
    return env.SLACK_USER_TOKEN;
  }
  return null;
}

/**
 * Call a Slack pins API method. As the app we use the shared web client and, on
 * `not_in_channel`, try to join the (public) channel once and retry — that's the
 * usual reason a bot can't pin in another channel. As kyto's account we use its
 * session (never joining for it); as the owner, the owner's token.
 */
async function callPins({
  actor,
  method,
  channelId,
  timestamp,
}: {
  actor: { as: Actor; ownerToken: string | null };
  method: 'pins.add' | 'pins.remove';
  channelId: string;
  timestamp: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (actor.as === 'account') {
    return okSchema.parse(
      await slack
        .requireUserAccountClient()
        .apiCall(method, { channel: channelId, timestamp })
    );
  }
  const userToken = actor.ownerToken;
  if (userToken) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      body: JSON.stringify({ channel: channelId, timestamp }),
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: 'POST',
    });
    return okSchema.parse(await response.json());
  }

  const first = okSchema.parse(
    await slack.webClient.apiCall(method, {
      channel: channelId,
      timestamp,
    })
  );
  if (first.ok || first.error !== 'not_in_channel' || method !== 'pins.add') {
    return first;
  }
  // Bot isn't in the target channel — join (public channels only) and retry.
  await slack.webClient
    .apiCall('conversations.join', { channel: channelId })
    .catch(() => undefined);
  return okSchema.parse(
    await slack.webClient.apiCall(method, { channel: channelId, timestamp })
  );
}

/** Resolve who acts, enforcing the owner gate for `as: 'owner'`. */
function resolveActor({
  as,
  asUserAccount,
  authorUserId,
}: {
  as: Actor | undefined;
  asUserAccount: boolean;
  authorUserId: string;
}):
  | { ok: true; as: Actor; ownerToken: string | null }
  | { ok: false; error: string } {
  const actor = as ?? (asUserAccount ? 'account' : 'app');
  if (actor === 'account') {
    if (!slack.userAccountId) {
      return {
        error: "kyto's user account is not configured; use 'app'.",
        ok: false,
      };
    }
    return { as: actor, ok: true, ownerToken: null };
  }
  if (actor === 'app') {
    return { as: actor, ok: true, ownerToken: null };
  }
  const ownerToken = ownerUserToken(authorUserId);
  if (!ownerToken) {
    return {
      error:
        'Pinning as the owner is only available when the owner triggers it.',
      ok: false,
    };
  }
  return { as: actor, ok: true, ownerToken };
}

export function pinMessageTool({
  asUserAccount,
  authorUserId,
  thread,
}: {
  asUserAccount: boolean;
  authorUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      'Pin a message to a Slack channel so the team can find it later. Defaults to the current channel; pass channelId to pin in another channel (the bot auto-joins public channels). Use for decisions, important links, or canonical answers.',
    inputSchema: z.object({
      as: actAsSchema,
      channelId: channelIdSchema,
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the message to pin, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ as, channelId, messageTs }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const actor = resolveActor({ as, asUserAccount, authorUserId });
        if (!actor.ok) {
          return { error: actor.error, success: false };
        }
        const result = await callPins({
          channelId: channel.channelId,
          method: 'pins.add',
          actor,
          timestamp: messageTs,
        });
        if (!result.ok) {
          return { error: `Pin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Pinned the message to <#${channel.channelId}> as ${ACTOR_LABEL[actor.as]}.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[pinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function unpinMessageTool({
  asUserAccount,
  authorUserId,
  thread,
}: {
  asUserAccount: boolean;
  authorUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      'Unpin a previously pinned message from a Slack channel. Defaults to the current channel; pass channelId to unpin in another channel.',
    inputSchema: z.object({
      as: actAsSchema,
      channelId: channelIdSchema,
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the pinned message to remove, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ as, channelId, messageTs }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const actor = resolveActor({ as, asUserAccount, authorUserId });
        if (!actor.ok) {
          return { error: actor.error, success: false };
        }
        const result = await callPins({
          channelId: channel.channelId,
          method: 'pins.remove',
          actor,
          timestamp: messageTs,
        });
        if (!result.ok) {
          return { error: `Unpin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Removed the pin from <#${channel.channelId}> as ${ACTOR_LABEL[actor.as]}.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[unpinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function bookmarkLinkTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Add a bookmark to a Slack channel so a link is always one click away in the channel header. Defaults to the current channel; pass channelId for another channel.',
    inputSchema: z.object({
      channelId: channelIdSchema,
      title: z
        .string()
        .min(1)
        .max(255)
        .describe('Label shown for the bookmark.'),
      link: z.string().url().describe('The URL to bookmark.'),
      emoji: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Optional emoji shortcode, e.g. :link:.'),
    }),
    execute: async ({ channelId, title, link, emoji }) => {
      try {
        const channel = resolveChannel(thread, channelId);
        if (!channel.ok) {
          return { error: channel.error, success: false };
        }
        const result = okSchema.parse(
          await slack.webClient.apiCall('bookmarks.add', {
            channel_id: channel.channelId,
            link,
            title,
            type: 'link',
            ...(emoji && { emoji }),
          })
        );
        if (!result.ok) {
          return { error: `Bookmark failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Bookmarked "${title}" in <#${channel.channelId}>.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[bookmarkLink] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
