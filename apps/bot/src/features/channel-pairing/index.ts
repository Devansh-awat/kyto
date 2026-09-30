import { addKytoChannels, listKytoChannelIds } from '@repo/db/queries';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { env } from '@/env';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// When either kyto — the app or its Slack user account — lands in a channel,
// the other one follows it in, and in a PRIVATE channel so does the owner
// (owner's call, 2026-09-30). The app sees its own joins as they happen; the
// account's joins are only visible by listing its channels (Slack delivers it
// no channel events), so a poller diffs both against `kyto_channels`.
//
// Only a channel NEW to an identity acts, once: re-inviting on every pass
// would pull someone straight back into a channel they just removed kyto or
// the owner from. The very first pass for an identity records what is there
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

async function listChannelIds(identity: Identity): Promise<string[]> {
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
}): Promise<void> {
  try {
    await clientFor(inviter).conversations.invite({
      channel: channelId,
      users: userId,
    });
    logger.info({ channelId, inviter, who }, '[channel-pairing] invited');
  } catch (error) {
    const code = slackErrorSchema.safeParse(error).data?.data?.error;
    if (code && HARMLESS.has(code)) {
      return;
    }
    logger.warn(
      { ...toLogError(error), channelId, code, inviter, who },
      '[channel-pairing] invite failed'
    );
  }
}

/** `joined` just landed in the channel: bring in the other kyto, and the owner if it is private. */
async function pairChannel({
  channelId,
  joined,
}: {
  channelId: string;
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
  const otherId = other === 'app' ? slack.botUserId : slack.userAccountId;
  if (otherId) {
    await invite({ channelId, inviter: joined, userId: otherId, who: other });
  }
  if (channel.is_private && env.OWNER_USER_ID) {
    await invite({
      channelId,
      inviter: joined,
      userId: env.OWNER_USER_ID,
      who: 'owner',
    });
  }
}

/** Record a join; pair the channel only if this identity had not been seen there. */
async function noteJoin({
  channelId,
  joined,
}: {
  channelId: string;
  joined: Identity;
}): Promise<void> {
  const fresh = await addKytoChannels({
    channelIds: [channelId],
    identity: joined,
  });
  if (fresh.length > 0) {
    await pairChannel({ channelId, joined });
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
  bot.onMemberJoinedChannel(async ({ channelId, userId }) => {
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
      await noteJoin({ channelId, joined });
    }
  });
  sweepAll().catch(() => undefined);
  setInterval(() => {
    sweepAll().catch(() => undefined);
  }, POLL_MS);
}
