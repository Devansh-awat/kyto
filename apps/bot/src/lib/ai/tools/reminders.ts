import {
  cancelReminder as cancelReminderRow,
  createReminder,
  listActiveReminders,
  pauseReminder as pauseReminderRow,
  type Reminder,
  type ReminderKind,
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

// How often each kind may fire, floored by what a fire actually costs.
// 'message'/'script' are a post and maybe an HTTP GET. 'bash' resumes a real
// sandbox. 'agent' runs a whole tool loop against a model.
const MIN_INTERVAL_SECONDS_DEFAULT = 60;
const MIN_INTERVAL_SECONDS_BASH = 5 * 60;
const MIN_INTERVAL_SECONDS_AGENT = 60 * 60;
const MIN_INTERVAL_SECONDS_BY_KIND: Record<ReminderKind, number> = {
  agent: MIN_INTERVAL_SECONDS_AGENT,
  bash: MIN_INTERVAL_SECONDS_BASH,
  message: MIN_INTERVAL_SECONDS_DEFAULT,
  script: MIN_INTERVAL_SECONDS_DEFAULT,
};

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
    description: `Schedule a RECURRING task for the user who sent the current message — kyto repeatedly posts on the schedule until cancelled or its run cap is reached. By default it DMs that user; the owner may also target a channel. For a one-time reminder, use scheduleReminder instead.

Four kinds, each recomputing its message at fire time except 'message':
- 'message' (default): posts \`text\` verbatim. Min interval 60s.
- 'script': fetches \`url\` and posts its content, prefixed by \`text\`. Min interval 60s.
- 'bash': runs \`command\` and posts its exact stdout/stderr, prefixed by \`text\`. It runs in THIS THREAD'S sandbox, which persists — so write a script to a file now, and the reminder can run it on every fire. Min interval 5 minutes.
- 'agent': runs \`text\` as instructions for a headless kyto with the full toolset (it can search, read Slack history, run bash, and decide what to say), and posts whatever it replies. Use this when the message must be computed fresh each time. Min interval 1 hour, since each fire is a real model run.`,
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(3000)
        .describe(
          "The message to post, or for kind 'agent' the instructions to follow."
        ),
      kind: z
        .enum(['message', 'script', 'bash', 'agent'])
        .optional()
        .describe("What runs each fire. Defaults to 'message'."),
      command: z
        .string()
        .min(1)
        .optional()
        .describe("Required when kind is 'bash'. The shell command to run."),
      url: z
        .string()
        .url()
        .optional()
        .describe("Required when kind is 'script'. The URL to fetch."),
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
      kind = 'message',
      command,
      url,
      channelId,
      maxRuns,
      recurrence,
      intervalSeconds,
      timeOfDayMinutes,
      weekday,
    }) => {
      if (kind === 'bash' && !command) {
        return { error: "kind 'bash' requires a command.", success: false };
      }
      if (kind === 'script' && !url) {
        return { error: "kind 'script' requires a url.", success: false };
      }

      let schedule: ReminderSchedule;
      if (recurrence === 'interval') {
        if (intervalSeconds === undefined) {
          return {
            error: "recurrence 'interval' requires intervalSeconds.",
            success: false,
          };
        }
        // Each fire of a bash/agent reminder costs a sandbox resume or a model
        // run, so they are floored well above the 60s the schema allows.
        const floor = MIN_INTERVAL_SECONDS_BY_KIND[kind];
        if (intervalSeconds < floor) {
          return {
            error: `kind '${kind}' can fire at most every ${floor} seconds (got ${intervalSeconds}).`,
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
          command: command ?? null,
          kind,
          maxRuns: maxRuns ?? null,
          schedule,
          text,
          // A 'bash' reminder reuses this thread's persistent sandbox, and an
          // 'agent' reminder runs its tools against this thread.
          threadId:
            kind === 'bash' || kind === 'agent' ? message.threadId : null,
          url: url ?? null,
          userId: message.author.userId,
        });
        const where = targetChannel ? `in <#${targetChannel}>` : 'via DM';
        const cap = maxRuns ? `, up to ${maxRuns} time(s)` : '';
        return {
          id: reminder.id,
          nextRunAt: reminder.nextRunAt.toISOString(),
          success: true,
          summary: `Scheduled a recurring ${kind} (${recurrence}) reminder ${where}${cap}. Next fires ${reminder.nextRunAt.toISOString()}.`,
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
          command: row.command ?? undefined,
          id: row.id,
          kind: row.kind,
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
