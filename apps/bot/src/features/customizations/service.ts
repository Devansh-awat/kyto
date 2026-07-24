import {
  getChatgptAccount,
  getIdentityProfiles,
  getUserCustomization,
  listMcpServers,
  listUserModelCredentials,
  listUserReminders,
} from '@repo/db/queries';
import { env } from '@/env';
import { byokConfigured } from '@/lib/byok';
import { slack } from '@/lib/chat';
import { buildHomeView } from './views';

export async function publishHome({
  userId,
}: {
  userId: string;
}): Promise<void> {
  const isOwner = Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
  const byokEnabled = byokConfigured();
  const [
    customization,
    mcpServers,
    identityProfiles,
    reminders,
    modelCredentials,
    chatgptAccount,
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
  ]);

  await slack.webClient.views.publish({
    user_id: userId,
    view: buildHomeView({
      byokEnabled,
      chatgptAccount: chatgptAccount ?? null,
      identityProfiles,
      isOwner,
      mcpServers,
      modelCredentials,
      prompt: customization?.prompt ?? null,
      reminders,
      showUsageFooter: customization?.showUsageFooter ?? true,
      userId,
    }) as never,
  });
}
