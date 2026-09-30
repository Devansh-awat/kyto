import { bot } from '@/bot';
import { env } from '@/env';
import { setOutboundFilter } from '@/harness';
import { runTurn, stopAllTurns } from '@/lib/agent';
import { startSummaryReaper } from '@/lib/agent/compaction';
import {
  markShuttingDown,
  startResumingOrphanedTurns,
} from '@/lib/agent/inflight';
import { startThinkingReaper } from '@/lib/agent/thinking';
import { buildAllowlist } from '@/lib/allowed-users';
import { slack, userBot } from '@/lib/chat';
import { startKevinton } from '@/lib/kevinton';
import logger from '@/lib/logger';
import { redactSecrets, setRedactionAlert } from '@/lib/redact';
import { startReminderScheduler } from '@/lib/reminders/scheduler';
import { startSandboxReaper } from '@/lib/sandbox/store';
import { startSitesServer } from '@/lib/sites/server';
import { ensureChannelIndex } from '@/lib/slack/channel-links';
import { flushThreadLogs, startThreadLogs } from '@/lib/thread-logs';
import { flushWhiteboards } from '@/lib/whiteboard/room';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // BEFORE the turns are stopped: stopping them would otherwise read as a
  // normal ending and forget them. The next instance resumes them.
  await markShuttingDown();
  stopAllTurns();
  logger.info({ signal }, '[bot] shutting down');
  // Kyto restarts after every change; without this the last few seconds of
  // everyone's drawing (the save debounce) would go with it.
  await flushWhiteboards().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] failed to save whiteboards');
  });
  // The stopped turns' last lines — often exactly what shows why they died.
  await flushThreadLogs();
  await bot.shutdown().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] error during shutdown');
  });
  await userBot?.shutdown().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] user-account connection shutdown');
  });
  process.exit(0);
}

// Every text kyto sends to Slack passes the secret-value scrub, and a catch is
// reported to the owner by NAME only (lib/redact).
setOutboundFilter((text) => redactSecrets(text, 'a Slack post'));
setRedactionAlert(({ context, fresh, labels }) => {
  logger.warn({ context, labels }, '[redact] a secret value was stripped');
  if (!env.OWNER_USER_ID || fresh.length === 0) {
    return;
  }
  bot
    .openDM(env.OWNER_USER_ID)
    .then((dm) =>
      dm.post({
        markdown: `:rotating_light: kyto stripped the value of ${fresh.join(', ')} out of ${context}. worth checking how it got there, and rotating it if it went anywhere.`,
      })
    )
    .catch((error: unknown) => {
      logger.warn({ err: error }, '[redact] could not alert the owner');
    });
});

try {
  // BEFORE connecting: events start arriving the moment the socket is up, and
  // an empty allowlist answered everyone — the owner included — with the
  // opt-in prompt for the few seconds it took to build.
  await buildAllowlist();
  await bot.initialize();
  // After the app's: it resolves the account id this connection's pings use.
  // A failure here must not take the app down with it.
  await userBot?.initialize().catch((error: unknown) => {
    logger.error({ err: error }, '[bot] user-account connection failed');
  });
  await startSitesServer();
  startReminderScheduler(bot);
  // Paused thread sandboxes keep costing storage; collect the idle ones.
  startSandboxReaper();
  // Reap thread reasoning older than the retention window.
  startThinkingReaper();
  startKevinton();
  startThreadLogs();
  // Same window, same reason, for compacted thread history.
  startSummaryReaper();
  // Warm the channel name→id index so the FIRST reply after a restart can
  // already turn `#some-channel` into a real link (see lib/slack/channel-links).
  await ensureChannelIndex();
  const botProfile = slack.botUserId
    ? await slack.webClient.users
        .info({ user: slack.botUserId })
        .catch(() => null)
    : null;
  // Turns a previous instance was in the middle of (lib/agent/inflight).
  startResumingOrphanedTurns({ bot, runTurn });
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
