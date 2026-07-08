import {
  getIdentityProfiles,
  getUserCustomization,
  listMcpServers,
} from '@repo/db/queries';
import { env } from '@/env';
import { slack } from '@/lib/chat';
import { buildHomeView } from './views';

export async function publishHome({
  userId,
}: {
  userId: string;
}): Promise<void> {
  const isOwner = Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
  const [customization, mcpServers, identityProfiles] = await Promise.all([
    getUserCustomization(userId),
    listMcpServers(userId).catch(() => []),
    isOwner ? getIdentityProfiles().catch(() => []) : Promise.resolve([]),
  ]);

  await slack.webClient.views.publish({
    user_id: userId,
    view: buildHomeView({
      identityProfiles,
      isOwner,
      mcpServers,
      prompt: customization?.prompt ?? null,
      showUsageFooter: customization?.showUsageFooter ?? true,
    }) as never,
  });
}
