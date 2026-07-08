import {
  cancelReminder as cancelReminderRow,
  createReminder,
  listActiveReminders,
  pauseReminder as pauseReminderRow,
  type Reminder,
  type ReminderSchedule,
  resumeReminder as resumeReminderRow,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { Message } from '@/harness';
import { toRawSlackChannelId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MAX_INTERVAL_SECONDS = 180 * 24 * 60 * 60;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function formatTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const mins = minutes % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} UTC`;
}

function describeSchedule(row: Reminder): string {
  if (row.recurrence === 'interval') {
    return `every ${row.intervalSeconds}s`;
  }
  const time = formatTimeOfDay(row.timeOfDayMinutes ?? 0);
  if (row.recurrence === 'daily') {
    return `daily at ${time}`;
  }
  return `weekly on ${WEEKDAY_NAMES[row.weekday ?? 0]} at ${time}`;
}

export function scheduleRecurringReminderTool({
  message,
}: {
  message: Message;
}) {
  const isOwner =
    Boolean(env.OWNER_USER_ID) && message.author.userId === env.OWNER_USER_ID;
  return tool({
    description:
      'Schedule a RECURRING reminder for the user who sent the current message — kyto repeatedly posts the given text on the schedule until cancelled or its run cap is reached. By default it DMs that user; the owner may also target a channel. Optionally cap the number of times it fires. For a one-time reminder, use scheduleReminder instead.',
    inputSchema: z.object({
      text: z.string().min(1).max(3000).describe('The message to post.'),
      channelId: z
        .string()
        .optional()
        .describe(
          'Owner only: post into this channel (id or #name) instead of DMing. Ignored for non-owners.'
        ),
      maxRuns: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional: stop after firing this many times.'),
      recurrence: z
        .enum(['interval', 'daily', 'weekly'])
        .describe(
          "'interval' repeats every N seconds; 'daily' fires once a day at a UTC time; 'weekly' fires once a week on a UTC weekday+time."
        ),
      intervalSeconds: z
        .number()
        .int()
        .min(60)
        .max(MAX_INTERVAL_SECONDS)
        .optional()
        .describe(
          "Required when recurrence is 'interval'. 60 to 15552000 (180 days)."
        ),
      timeOfDayMinutes: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_PER_DAY - 1)
        .optional()
        .describe(
          "Required when recurrence is 'daily' or 'weekly'. Minutes since UTC midnight, e.g. 9:00 UTC = 540."
        ),
      weekday: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe(
          "Required when recurrence is 'weekly'. 0 = Sunday through 6 = Saturday, UTC."
        ),
    }),
    execute: async ({
      text,
      channelId,
      maxRuns,
      recurrence,
      intervalSeconds,
      timeOfDayMinutes,
      weekday,
    }) => {
      let schedule: ReminderSchedule;
      if (recurrence === 'interval') {
        if (intervalSeconds === undefined) {
          return {
            error: "recurrence 'interval' requires intervalSeconds.",
            success: false,
          };
        }
        schedule = { recurrence: 'interval', intervalSeconds };
      } else if (recurrence === 'daily') {
        if (timeOfDayMinutes === undefined) {
          return {
            error: "recurrence 'daily' requires timeOfDayMinutes.",
            success: false,
          };
        }
        schedule = { recurrence: 'daily', timeOfDayMinutes };
      } else {
        if (timeOfDayMinutes === undefined || weekday === undefined) {
          return {
            error: "recurrence 'weekly' requires timeOfDayMinutes and weekday.",
            success: false,
          };
        }
        schedule = { recurrence: 'weekly', timeOfDayMinutes, weekday };
      }

      // Only the owner may aim a reminder at a channel (same admin rule as
      // cross-channel posting); non-owners always get a DM.
      const targetChannel =
        isOwner && channelId ? toRawSlackChannelId(channelId) : null;

      try {
        const reminder = await createReminder({
          channelId: targetChannel,
          maxRuns: maxRuns ?? null,
          schedule,
          text,
          userId: message.author.userId,
        });
        const where = targetChannel ? `in <#${targetChannel}>` : 'via DM';
        const cap = maxRuns ? `, up to ${maxRuns} time(s)` : '';
        return {
          id: reminder.id,
          nextRunAt: reminder.nextRunAt.toISOString(),
          success: true,
          summary: `Scheduled a recurring (${recurrence}) reminder ${where}${cap}. Next fires ${reminder.nextRunAt.toISOString()}.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function listRemindersTool({ message }: { message: Message }) {
  return tool({
    description:
      "List the current user's active recurring reminders, including their id (needed to cancel, pause, or resume one).",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await listActiveReminders(message.author.userId);
      return {
        reminders: rows.map((row) => ({
          id: row.id,
          nextRunAt: row.nextRunAt.toISOString(),
          recurrence: row.recurrence,
          runs: row.maxRuns
            ? `${row.runCount}/${row.maxRuns}`
            : `${row.runCount}`,
          schedule: describeSchedule(row),
          target: row.channelId ? `<#${row.channelId}>` : 'DM',
          text: row.text,
        })),
        success: true,
      };
    },
  });
}

export function pauseReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Pause one of the current user's recurring reminders by id — it stops firing but is kept, so it can be resumed later. Get the id from listReminders.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const paused = await pauseReminderRow({
        id,
        userId: message.author.userId,
      });
      return paused
        ? { success: true, summary: 'Reminder paused.' }
        : {
            error: 'No matching reminder found for this user.',
            success: false,
          };
    },
  });
}

export function resumeReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Resume one of the current user's paused reminders by id. Get the id from listReminders.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const resumed = await resumeReminderRow({
        id,
        userId: message.author.userId,
      });
      return resumed
        ? { success: true, summary: 'Reminder resumed.' }
        : {
            error: 'No matching reminder found for this user.',
            success: false,
          };
    },
  });
}

export function cancelReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Cancel one of the current user's recurring reminders by id (get the id from listReminders).",
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      const cancelled = await cancelReminderRow({
        id,
        userId: message.author.userId,
      });
      return cancelled
        ? { success: true }
        : {
            error: 'No matching active reminder found for this user.',
            success: false,
          };
    },
  });
}
