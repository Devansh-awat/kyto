import { env } from '@/env';
import { membersCanPost } from '@/lib/ai/tools/channels';
import { slack } from '@/lib/chat';
import { isMember } from '@/lib/slack/channel-access';

/**
 * Why `userId`'s reminder may NOT post in `channelId`, or undefined when it
 * may. Anyone may aim a reminder at a channel (owner's call 2026-11-03), but
 * only one they are in, that kyto is in, and where ordinary members may post:
 * a reminder posts as its creator's job, so it reaches no further than they
 * could themselves. Checked at save AND on every run (they may have left).
 * Fails closed. The owner is unrestricted, as before.
 */
export async function reminderChannelRefusal({
  channelId,
  userId,
}: {
  channelId: string;
  userId: string;
}): Promise<string | undefined> {
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID) {
    return;
  }
  try {
    const info = await slack.webClient.conversations.info({
      channel: channelId,
    });
    if (info.channel?.is_im || info.channel?.is_mpim) {
      return 'A reminder can post in a channel or in your DM, not in a group DM or someone else’s DM.';
    }
    if (!info.channel?.is_member) {
      return `kyto isn't in <#${channelId}>. Invite it there first.`;
    }
    if (!(await isMember({ channel: channelId, userId }))) {
      return `You aren't in <#${channelId}>, so your reminder can't post there.`;
    }
  } catch {
    return `kyto can't see <#${channelId}>. Invite it there first.`;
  }
  if (!(await membersCanPost(channelId))) {
    return `Only admins can post in <#${channelId}>.`;
  }
  return;
}
