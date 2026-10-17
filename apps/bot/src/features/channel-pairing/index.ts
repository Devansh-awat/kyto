import { addKytoChannels, listKytoChannelIds } from '@repo/db/queries';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { env } from '@/env';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// When either kyto — the app or its Slack user account — lands in a channel,
// the other one follows it in, and a PRIVATE channel is DM'd to the owner by
// name and id (owner's call, 2026-10-16: he used to be invited in, which
// members read as kyto bringing in a watcher; a channel mention in the DM
// would be unreadable to him from outside, so it is plain text). The app sees its own joins as they happen; the
// account's joins are only visible by listing its channels (Slack delivers it
// no channel events), so a poller diffs both against `kyto_channels`.
//
// Only a channel NEW to an identity acts, once: re-inviting on every pass
// would pull someone straight back into a channel they just removed kyto
// from, and DM the owner about it again. The very first pass for an identity records what is there
// and invites no one — otherwise switching this on invites into every
// channel kyto has ever been in.

const POLL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 200;
// Slack's answers that mean "nothing to do", not a failure.
const HARMLESS = new Set(['already_in_channel', 'cant_invite_self']);
const slackErrorSchema = z.looseObject({
  data: z.looseObject({ error: z.string().optional() }).optional(),
});

type Identity = 'app' | 'user';

function clientFor(identity: Identity): WebClient {
  return identity === 'app'
    ? slack.webClient
    : slack.requireUserAccountClient();
}

// What `client.counts` answers with: the Slack client's own list of the
// conversations its user is in (DMs and group DMs are separate keys).
const countsSchema = z.object({
  channels: z.array(z.object({ id: z.string() })).default([]),
});

async function listChannelIds(identity: Identity): Promise<string[]> {
  if (identity === 'user') {
    // The enterprise refuses `users.conversations` to a browser session
    // (`enterprise_is_restricted`); the Slack client lists its channels this
    // way instead.
    const counts = countsSchema.parse(
      await slack.requireUserAccountClient().apiCall('client.counts')
    );
    return counts.channels.map((channel) => channel.id);
  }
  const client = clientFor(identity);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.users.conversations({
      exclude_archived: true,
      limit: PAGE_SIZE,
      types: 'public_channel,private_channel',
      ...(cursor ? { cursor } : {}),
    });
    for (const channel of page.channels ?? []) {
      if (channel.id) {
        ids.push(channel.id);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

async function invite({
  channelId,
  inviter,
  userId,
  who,
}: {
  channelId: string;
  inviter: Identity;
  userId: string;
  who: string;
}): Promise<boolean> {
  try {
    await clientFor(inviter).conversations.invite({
      channel: channelId,
      users: userId,
    });
    logger.info({ channelId, inviter, who }, '[channel-pairing] invited');
    return true;
  } catch (error) {
    const code = slackErrorSchema.safeParse(error).data?.data?.error;
    if (!(code && HARMLESS.has(code))) {
      logger.warn(
        { ...toLogError(error), channelId, code, inviter, who },
        '[channel-pairing] invite failed'
      );
    }
    return false;
  }
}

/** `joined` just landed in the channel: bring in the other kyto, and tell the owner if it is private. */
async function pairChannel({
  channelId,
  inviter,
  joined,
}: {
  channelId: string;
  /** Who added it, when Slack said (the join event; the poller can't know). */
  inviter?: string;
  joined: Identity;
}): Promise<void> {
  const info = await clientFor(joined)
    .conversations.info({ channel: channelId })
    .catch(() => undefined);
  const channel = info?.channel;
  // A DM, a group DM or an archived channel is nothing to pair.
  if (!channel || channel.is_im || channel.is_mpim || channel.is_archived) {
    return;
  }
  const other: Identity = joined === 'app' ? 'user' : 'app';
  // The other kyto follows this one in and counts as new there too: one DM
  // per channel, from whichever arrived first.
  const otherWasThere = (await listKytoChannelIds(other)).includes(channelId);
  const otherId = other === 'app' ? slack.botUserId : slack.userAccountId;
  if (otherId) {
    await invite({ channelId, inviter: joined, userId: otherId, who: other });
  }
  const owner = env.OWNER_USER_ID;
  if (!(channel.is_private && owner) || otherWasThere) {
    return;
  }
  const who = joined === 'app' ? "kyto's app" : "kyto's user account";
  const by = inviter ? ` by <@${inviter}>` : '';
  try {
    const dm = await bot.openDM(owner);
    await dm.post({
      markdown: `${who} was added${by} to the private channel ${channel.name ?? '(name unknown)'} (${channelId}).`,
    });
    logger.info({ channelId, joined }, '[channel-pairing] owner told');
  } catch (error) {
    logger.warn(
      { ...toLogError(error), channelId },
      '[channel-pairing] owner DM failed'
    );
  }
}

/** Record a join; pair the channel only if this identity had not been seen there. */
async function noteJoin({
  channelId,
  inviter,
  joined,
}: {
  channelId: string;
  inviter?: string;
  joined: Identity;
}): Promise<void> {
  const fresh = await addKytoChannels({
    channelIds: [channelId],
    identity: joined,
  });
  if (fresh.length > 0) {
    await pairChannel({ channelId, inviter, joined });
  }
}

async function sweep(identity: Identity): Promise<void> {
  const known = await listKytoChannelIds(identity);
  const current = await listChannelIds(identity);
  const fresh = await addKytoChannels({ channelIds: current, identity });
  if (known.length === 0) {
    logger.info(
      { count: fresh.length, identity },
      '[channel-pairing] first pass: recorded channels, invited no one'
    );
    return;
  }
  for (const channelId of fresh) {
    await pairChannel({ channelId, joined: identity });
  }
}

async function sweepAll(): Promise<void> {
  // Both kytos must exist to pair them.
  if (!(slack.userAccountId && slack.botUserId)) {
    return;
  }
  for (const identity of ['app', 'user'] as const) {
    await sweep(identity).catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), identity },
        '[channel-pairing] sweep failed'
      );
    });
  }
}

export function startChannelPairing(): void {
  // The fast path: the app sees a member join in any channel it is in — its
  // own join, or the account's.
  bot.onMemberJoinedChannel(async ({ channelId, inviter, userId }) => {
    if (!slack.userAccountId) {
      return;
    }
    let joined: Identity | undefined;
    if (userId === slack.botUserId) {
      joined = 'app';
    } else if (userId === slack.userAccountId) {
      joined = 'user';
    }
    if (joined) {
      await noteJoin({ channelId, inviter, joined });
    }
  });
  sweepAll().catch(() => undefined);
  setInterval(() => {
    sweepAll().catch(() => undefined);
  }, POLL_MS);
}
