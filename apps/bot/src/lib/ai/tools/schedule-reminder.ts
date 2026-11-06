import { computeNextRun, createReminder } from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import type { Message } from '@/harness/types';
import { bot } from '@/lib/chat';
import { errorMessage } from '@/lib/utils/error';

const DAY_SECONDS = 24 * 60 * 60;
// Slack's own scheduled messages stop at 120 days out.
const SLACK_SCHEDULE_MAX_SECONDS = 120 * DAY_SECONDS;
// Past that, kyto's own scheduler holds it: a once-a-year cron that runs once.
const MAX_SECONDS = 365 * DAY_SECONDS;
// The cron fires at the minute; the requested second can't be matched.
const SAME_MINUTE_MS = 60_000;

export function scheduleReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      'Schedule a ONE-TIME reminder DM to the user who sent the current message, up to a year ahead. It fires once and is gone. A request to be reminded once ("in 215 days", "on 30 May") is always this tool, never a recurring reminder: a weekly job that checks the date posts every week, which is exactly what they did not ask for.',
    inputSchema: z.object({
      text: z.string().min(1).max(3000),
      seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_SECONDS)
        .describe('How long from now, in seconds (up to 365 days).'),
    }),
    execute: async ({ text, seconds }) => {
      const postAt = new Date(Date.now() + seconds * 1000);
      try {
        if (seconds <= SLACK_SCHEDULE_MAX_SECONDS) {
          const dm = await bot.openDM(message.author);
          await dm.schedule({ markdown: text }, { postAt });
          return {
            scheduledFor: postAt.toISOString(),
            success: true,
            userId: message.author.userId,
          };
        }
        // Further out than Slack schedules: a reminder of kyto's own that
        // fires on that date and time (UTC) once, as a DM. It used to be
        // refused, and the model built a weekly "is it the day yet" job
        // instead, which posted a countdown every week (#185).
        const schedule = {
          cronExpression: `${postAt.getUTCMinutes()} ${postAt.getUTCHours()} ${postAt.getUTCDate()} ${postAt.getUTCMonth() + 1} *`,
          recurrence: 'cron' as const,
          timezone: 'UTC',
        };
        const firesAt = computeNextRun(schedule, new Date());
        if (Math.abs(firesAt.getTime() - postAt.getTime()) > SAME_MINUTE_MS) {
          return {
            error: `Can't schedule that exact date (${postAt.toISOString()}); pick a nearby day.`,
            success: false,
          };
        }
        const reminder = await createReminder({
          kind: 'message',
          maxRuns: 1,
          schedule,
          text,
          userId: message.author.userId,
        });
        return {
          id: reminder.id,
          scheduledFor: firesAt.toISOString(),
          success: true,
          summary: `One-time reminder set for ${firesAt.toISOString()}, as a DM. It fires once; they can see, edit or cancel it in kyto's App Home (Reminders).`,
          userId: message.author.userId,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
