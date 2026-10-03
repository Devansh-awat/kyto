import { slack } from '@/lib/chat';
import { toRawSlackChannelId } from '@/lib/slack/ids';

// kyto's bot token reads every private channel, DM and group DM kyto is in. A
// read on someone's behalf must not: asked from #general, "summarize #exec"
// would hand a private channel to anyone, and the sandbox's Slack proxy would
// hand over kyto's DMs with other people. The rule (owner's call 2026-10-03):
// a conversation that isn't public is readable from ANOTHER conversation only
// by someone who is a member of it. The conversation the turn is in is always
// readable — everyone asking from there is in it.

const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
const MEMBERS_PAGE = 1000;
const verdicts = new Map<string, { at: number; allowed: boolean }>();

async function isPublicChannel(channel: string): Promise<boolean> {
  const info = await slack.webClient.conversations.info({ channel });
  const conversation = info.channel;
  return Boolean(
    conversation &&
      !conversation.is_private &&
      !conversation.is_im &&
      !conversation.is_mpim
  );
}

async function isMember({
  channel,
  userId,
}: {
  channel: string;
  userId: string;
}): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await slack.webClient.conversations.members({
      channel,
      cursor,
      limit: MEMBERS_PAGE,
    });
    if (page.members?.includes(userId)) {
      return true;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return false;
}

/**
 * Whether `askerUserId` may have kyto read `channelId` while the turn is in
 * `currentChannelId`. Public channels: yes. Anything else: only a member.
 * Fails CLOSED — an info/members error is a no.
 */
export async function mayReadChannel({
  askerUserId,
  channelId,
  currentChannelId,
}: {
  askerUserId: string | undefined;
  channelId: string;
  currentChannelId: string | undefined;
}): Promise<boolean> {
  const channel = toRawSlackChannelId(channelId);
  if (currentChannelId && channel === toRawSlackChannelId(currentChannelId)) {
    return true;
  }
  const key = `${channel}:${askerUserId ?? ''}`;
  const cached = verdicts.get(key);
  if (cached && Date.now() - cached.at < MEMBERSHIP_TTL_MS) {
    return cached.allowed;
  }
  let allowed: boolean;
  try {
    allowed =
      (await isPublicChannel(channel)) ||
      (Boolean(askerUserId) &&
        (await isMember({ channel, userId: askerUserId ?? '' })));
  } catch {
    return false;
  }
  verdicts.set(key, { allowed, at: Date.now() });
  return allowed;
}

export const PRIVATE_CHANNEL_REFUSAL =
  "That conversation is private and the person asking isn't a member of it, so kyto won't read it on their behalf. Only members can have kyto read a private channel or DM from somewhere else — ask them to post it here, or ask from inside that channel.";
