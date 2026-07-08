import {
  advanceReminder,
  getDueReminders,
  type Reminder,
} from '@repo/db/queries';
import type { KytoBot as Chat } from '@/harness';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Recurring reminders are Kyto's own durable side effect (unlike per-turn
// agent/sandbox state, which is deliberately not persisted) — same precedent
// as static site hosting and the opt-in allowlist. A single setInterval loop
// on the always-on systemd process is sufficient; Slack's own
// chat.scheduleMessage API (used by the one-time `scheduleReminder` tool)
// only supports a single future timestamp, not recurrence, so recurring
// reminders must be driven from here instead.
const POLL_INTERVAL_MS = 30_000;

async function fireReminder(bot: Chat, reminder: Reminder): Promise<void> {
  try {
    const identity = await resolveIdentity('reminder');
    // A channel target posts into that channel; otherwise DM the owner.
    const target = reminder.channelId
      ? bot.channel(reminder.channelId)
      : await bot.openDM(reminder.userId);
    const mention = reminder.channelId ? `<@${reminder.userId}> ` : '';
    await target.post({
      iconEmoji: identity.iconEmoji,
      iconUrl: identity.iconUrl,
      markdown: `${mention}${reminder.text}`,
      username: identity.username,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to post reminder DM'
    );
  }
  await advanceReminder(reminder).catch((error: unknown) => {
    logger.error(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to advance reminder to its next run'
    );
  });
}

async function pollOnce(bot: Chat): Promise<void> {
  const due = await getDueReminders(new Date());
  for (const reminder of due) {
    await fireReminder(bot, reminder);
  }
}

export function startReminderScheduler(bot: Chat): void {
  const tick = (): void => {
    pollOnce(bot).catch((error: unknown) => {
      logger.error({ err: errorMessage(error) }, '[reminders] poll failed');
    });
  };
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS },
    '[reminders] scheduler started'
  );
}
