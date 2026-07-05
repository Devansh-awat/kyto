import { SlackFormatConverter } from '@chat-adapter/slack';
import {
  advanceReminder,
  getDueReminders,
  MAX_RECURRING_RUNS,
  type Reminder,
} from '@repo/db/queries';
import type { Chat } from 'chat';
import { fetchUrlText } from '@/lib/ai/tools/url';
import { slack } from '@/lib/chat';
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

// Reminder-fired messages are posted with a distinct bot identity (needs
// `chat:write.customize`) so they read as visibly different from a live
// reply. This bypasses the chat-sdk's own `Thread.post`/`Channel.post`
// (which has no username/icon override anywhere) and calls chat.postMessage
// directly — reusing the adapter's OWN exported SlackFormatConverter so the
// markdown is rendered identically to a normal post, just with the identity
// override merged in. Kept intentionally small/local rather than patching
// @chat-adapter/slack (as the DM-threading fix does) — three call sites
// across two packages would need patching for this, versus one local
// function here, and it only needs to cover this one caller.
const formatConverter = new SlackFormatConverter();
const REMINDER_USERNAME = 'kyto (reminder)';
const REMINDER_ICON_EMOJI = ':alarm_clock:';

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

/** Resolve the raw Slack channel id to post to: an explicit channel, or the
 * user's DM (opened via the chat-sdk so a fresh DM is created if needed). */
async function resolveRawChannelId(
  bot: Chat,
  reminder: Reminder
): Promise<string> {
  if (reminder.channelId) {
    return reminder.channelId;
  }
  const dmThread = await bot.openDM(reminder.userId);
  return slack.decodeThreadId(dmThread.id).channel;
}

/** Post with the "kyto (reminder)" identity — see the module-level comment
 * on why this bypasses the chat-sdk's own post methods. */
async function postReminderMessage(
  bot: Chat,
  reminder: Reminder,
  markdown: string
): Promise<void> {
  const channel = await resolveRawChannelId(bot, reminder);
  const payload = formatConverter.toSlackPayload({ markdown });
  await slack.webClient.apiCall('chat.postMessage', {
    channel,
    icon_emoji: REMINDER_ICON_EMOJI,
    unfurl_links: false,
    unfurl_media: false,
    username: REMINDER_USERNAME,
    ...payload,
  });
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
    await postReminderMessage(bot, reminder, markdown);
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
