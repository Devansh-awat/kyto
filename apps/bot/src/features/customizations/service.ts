import { getUserCustomization, listMcpServers } from '@repo/db/queries';
import { slack } from '@/lib/chat';
import { buildHomeView } from './views';

export async function publishHome({
  userId,
}: {
  userId: string;
}): Promise<void> {
  const [customization, mcpServers] = await Promise.all([
    getUserCustomization(userId),
    listMcpServers(userId).catch(() => []),
  ]);

  await slack.webClient.views.publish({
    user_id: userId,
    view: buildHomeView({
      mcpServers,
      prompt: customization?.prompt ?? null,
      showUsageFooter: customization?.showUsageFooter ?? true,
    }) as never,
  });
}
