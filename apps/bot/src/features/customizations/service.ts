import {
  type ChannelGroupWithChannels,
  getChatgptAccount,
  getIdentityProfiles,
  getSlackGrant,
  getUserCustomization,
  listChannelGroups,
  listMcpServerShares,
  listMcpServers,
  listUserModelCredentials,
  listUserReminders,
} from '@repo/db/queries';
import { env } from '@/env';
import { getMcpFailure } from '@/lib/ai/mcp';
import { byokConfigured } from '@/lib/byok';
import { slack } from '@/lib/chat';
import { slackOauthConfigured } from '@/lib/slack-oauth';
import { previewUserData } from './erase';
import { buildHomeView } from './views';

export async function publishHome({
  userId,
}: {
  userId: string;
}): Promise<void> {
  const isOwner = Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
  const byokEnabled = byokConfigured();
  const slackOauthEnabled = slackOauthConfigured();
  const [
    customization,
    mcpServers,
    identityProfiles,
    reminders,
    modelCredentials,
    chatgptAccount,
    slackGrant,
    privacy,
    channelGroups,
  ] = await Promise.all([
    getUserCustomization(userId),
    listMcpServers(userId).catch(() => []),
    isOwner ? getIdentityProfiles().catch(() => []) : Promise.resolve([]),
    listUserReminders(userId).catch(() => []),
    byokEnabled
      ? listUserModelCredentials(userId).catch(() => [])
      : Promise.resolve([]),
    byokEnabled
      ? getChatgptAccount(userId).catch(() => undefined)
      : Promise.resolve(undefined),
    slackOauthEnabled
      ? getSlackGrant(userId).catch(() => null)
      : Promise.resolve(null),
    // Best-effort: the "Your data" section still renders (with generic wording)
    // if the counts can't be read, because the erase buttons must never vanish.
    previewUserData(userId).catch(() => undefined),
    listChannelGroups().catch(() => [] as ChannelGroupWithChannels[]),
  ]);

  // Where each of this person's servers is shared, rendered for the row. Read
  // per server rather than in one query because the list is short (a person has
  // a handful of servers) and the App Home publish is not on a hot path.
  const shareEntries = await Promise.all(
    mcpServers.map(async (server) => {
      const shares = await listMcpServerShares(server.id).catch(() => []);
      const groupNames = new Map(
        channelGroups.map((group) => [group.id, group.name])
      );
      return [
        server.id,
        shares.map((share) =>
          share.scopeKind === 'group'
            ? `group ${groupNames.get(share.scopeId) ?? share.scopeId}`
            : `<#${share.scopeId}>`
        ),
      ] as const;
    })
  );

  await slack.webClient.views.publish({
    user_id: userId,
    view: buildHomeView({
      byokEnabled,
      channelGroups,
      chatgptAccount: chatgptAccount ?? null,
      identityProfiles,
      isOwner,
      mcpFailures: Object.fromEntries(
        mcpServers.flatMap((server) => {
          const failure = getMcpFailure(server.id);
          return failure ? [[server.name, failure.message]] : [];
        })
      ),
      mcpServers,
      mcpShares: Object.fromEntries(
        shareEntries.filter(([, names]) => names.length > 0)
      ),
      modelCredentials,
      privacy,
      prompt: customization?.prompt ?? null,
      reminders,
      showUsageFooter: customization?.showUsageFooter ?? true,
      slackGrant: slackGrant ?? null,
      slackOauthEnabled,
      userId,
    }) as never,
  });
}
