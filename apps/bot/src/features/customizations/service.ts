import {
  getIdentityProfiles,
  getUserCustomization,
  listMcpServers,
  listUserReminders,
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
  const [customization, mcpServers, identityProfiles, reminders] =
    await Promise.all([
      getUserCustomization(userId),
      listMcpServers(userId).catch(() => []),
      isOwner ? getIdentityProfiles().catch(() => []) : Promise.resolve([]),
      listUserReminders(userId).catch(() => []),
    ]);

  await slack.webClient.views.publish({
    user_id: userId,
    view: buildHomeView({
      identityProfiles,
      isOwner,
      mcpServers,
      prompt: customization?.prompt ?? null,
      reminders,
      showUsageFooter: customization?.showUsageFooter ?? true,
      userId,
    }) as never,
  });
}
