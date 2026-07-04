import {
  advanceReminder,
  getDueReminders,
  MAX_RECURRING_RUNS,
  type Reminder,
} from '@repo/db/queries';
import type { Chat } from 'chat';
import { fetchUrlText } from '@/lib/ai/tools/url';
import logger from '@/lib/logger';
import { runReminderAgent } from '@/lib/reminders/agent';
import { runReminderBash } from '@/lib/reminders/bash';
import { errorMessage } from '@/lib/utils/error';

// Recurring reminders are Kyto's own durable side effect (unlike per-turn
// agent/sandbox state, which is deliberately not persisted) — same precedent
// as static site hosting and the opt-in allowlist. A single setInterval loop
// on the always-on systemd process is sufficient; Slack's own
// chat.scheduleMessage API (used by the one-time `scheduleReminder` tool)
// only supports a single future timestamp, not recurrence, so recurring
// reminders must be driven from here instead.
const POLL_INTERVAL_MS = 30_000;

/** Build the message text for a reminder, branching on its kind. */
async function buildReminderMessage(reminder: Reminder): Promise<string> {
  if (reminder.kind === 'script') {
    if (!reminder.url) {
      throw new Error("Script reminder is missing a 'url'.");
    }
    const { content } = await fetchUrlText(reminder.url);
    return reminder.text ? `${reminder.text}\n\n${content}` : content;
  }
  if (reminder.kind === 'agent') {
    return await runReminderAgent(reminder);
  }
  if (reminder.kind === 'bash') {
    if (!reminder.command) {
      throw new Error("Bash reminder is missing a 'command'.");
    }
    const output = await runReminderBash(reminder.command);
    const fenced = `\`\`\`\n${output}\n\`\`\``;
    return reminder.text ? `${reminder.text}\n\n${fenced}` : fenced;
  }
  return reminder.text;
}

/** Resolve where to post: an explicit channel the bot is in, or the user's DM. */
async function resolveTarget(
  bot: Chat,
  reminder: Reminder
): Promise<{ post: (message: { markdown: string }) => Promise<unknown> }> {
  if (reminder.channelId) {
    return bot.channel(`slack:${reminder.channelId}`);
  }
  return await bot.openDM(reminder.userId);
}

async function fireReminder(bot: Chat, reminder: Reminder): Promise<void> {
  let markdown: string;
  try {
    markdown = await buildReminderMessage(reminder);
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to build reminder content'
    );
    markdown = `Reminder: ${reminder.text}\n\n_(Couldn't complete this run: ${errorMessage(error)})_`;
  }

  const isFinalRun = reminder.runCount + 1 >= MAX_RECURRING_RUNS;
  if (isFinalRun) {
    markdown += `\n\n_This was the final scheduled run (${MAX_RECURRING_RUNS}/${MAX_RECURRING_RUNS}) — this reminder is now cancelled._`;
  }

  try {
    const target = await resolveTarget(bot, reminder);
    await target.post({ markdown });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] failed to post reminder'
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
