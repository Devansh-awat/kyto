import { bot } from '@/bot';
import { stopAllTurns } from '@/lib/agent';
import { installModelCapture } from '@/lib/agent/resolved-model';
import { buildAllowlist } from '@/lib/allowed-users';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { startReminderScheduler } from '@/lib/reminders/scheduler';
import { startSitesServer } from '@/lib/sites/server';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopAllTurns();
  logger.info({ signal }, '[bot] shutting down');
  await bot.shutdown().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] error during shutdown');
  });
  process.exit(0);
}

try {
  installModelCapture();
  await bot.initialize();
  await buildAllowlist();
  await startSitesServer();
  startReminderScheduler(bot);
  const botProfile = slack.botUserId
    ? await slack.webClient.users
        .info({ user: slack.botUserId })
        .catch(() => null)
    : null;
  logger.info(
    `[bot] ${botProfile?.user?.profile?.display_name || botProfile?.user?.profile?.real_name || botProfile?.user?.name || 'kyto'} (${slack.botUserId ?? 'unknown id'}) is online`
  );
} catch (error) {
  logger.error({ err: error }, '[bot] failed to start');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ err: error }, '[bot] shutdown failed');
      process.exit(1);
    });
  });
}
