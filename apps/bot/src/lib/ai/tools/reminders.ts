import {
  cancelReminder as cancelReminderRow,
  createReminder,
  listActiveReminders,
  MAX_RECURRING_RUNS,
  pauseReminder as pauseReminderRow,
  type Reminder,
  type ReminderSchedule,
  resumeReminder as resumeReminderRow,
} from '@repo/db/queries';
import { tool } from 'ai';
import type { Message } from 'chat';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import { toChatSlackChannelId, toRawSlackChannelId } from '@/lib/slack/ids';
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
// 'script' reminders just fetch a URL, so they can run as often as once a
// minute. 'bash' reminders spin up a real sandbox each run (real compute cost,
// not just an HTTP call), so they're floored higher than 'script' but well
// below 'agent'. 'agent' reminders run a real (if small) LLM call, so they're
// floored much higher still to keep unattended cost predictable.
const MIN_INTERVAL_SECONDS_DEFAULT = 60;
const MIN_INTERVAL_SECONDS_BASH = 5 * 60;
const MIN_INTERVAL_SECONDS_AGENT = 60 * 60;
const MIN_INTERVAL_SECONDS_BY_KIND: Partial<Record<string, number>> = {
  agent: MIN_INTERVAL_SECONDS_AGENT,
  bash: MIN_INTERVAL_SECONDS_BASH,
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

const conversationsInfoSchema = z.looseObject({
  channel: z.looseObject({ is_member: z.boolean().optional() }).optional(),
  error: z.string().optional(),
  ok: z.boolean(),
});

/** Verify kyto is currently a member of the target channel (never auto-joins —
 * an unattended recurring reminder should never trigger a surprise join). */
async function assertBotIsMember(rawChannelId: string): Promise<void> {
  const result = conversationsInfoSchema.parse(
    await slack.webClient.apiCall('conversations.info', {
      channel: rawChannelId,
    })
  );
  if (!(result.ok && result.channel?.is_member)) {
    throw new Error(
      `Kyto is not a member of ${rawChannelId}. It can only post recurring reminders to channels it's already in.`
    );
  }
}

export function scheduleRecurringReminderTool({
  message,
}: {
  message: Message;
}) {
  return tool({
    description: `Schedule a RECURRING reminder — kyto will repeatedly post on the given schedule until cancelled, either to the user's own DM (default) or to a channel kyto is already a member of (pass channelId). Every recurring reminder auto-cancels after ${MAX_RECURRING_RUNS} runs regardless of kind. Four kinds: 'message' just posts text verbatim; 'script' fetches a url each run and posts its content (min interval 1 minute); 'bash' runs a shell command in a fresh sandbox each run and posts its exact stdout/stderr (min interval 5 minutes — use this for actual parsing/processing logic, not just a raw fetch); 'agent' runs a small LLM (kyto's own Gemini key, gemini-3.1-flash-lite) with text as its instructions — it can fetch a URL itself and decides what to post (min interval 1 hour, since it's a real model call each run). For a one-time reminder, use scheduleReminder instead.`,
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(3000)
        .describe(
          "The message to post ('message' kind), an optional prefix before the fetched content/command output ('script'/'bash' kinds), or the instructions for the agent ('agent' kind)."
        ),
      kind: z
        .enum(['message', 'script', 'agent', 'bash'])
        .default('message')
        .describe(
          "'message' (default): post text verbatim. 'script': fetch url and post its content. 'bash': run command in a fresh sandbox and post its exact output. 'agent': run a small LLM on text as instructions and post what it produces."
        ),
      url: z
        .string()
        .url()
        .optional()
        .describe(
          "Required for kind 'script' (the URL to fetch each run). Optional for kind 'agent' (a URL the agent's instructions reference)."
        ),
      command: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe(
          "Required for kind 'bash': the shell command to run in a fresh sandbox each fire. Its exact stdout/stderr is posted verbatim."
        ),
      channelId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Slack channel id to post to instead of the user's DM (e.g. C0123ABC). Kyto must already be a member of this channel — it will NOT auto-join for an unattended reminder."
        ),
      recurrence: z
        .enum(['interval', 'daily', 'weekly'])
        .describe(
          "'interval' repeats every N seconds; 'daily' fires once a day at a UTC time; 'weekly' fires once a week on a UTC weekday+time."
        ),
      intervalSeconds: z
        .number()
        .int()
        .min(MIN_INTERVAL_SECONDS_DEFAULT)
        .max(MAX_INTERVAL_SECONDS)
        .optional()
        .describe(
          "Required when recurrence is 'interval'. 60 to 15552000 (180 days) for 'message'/'script'; at least 300 (5 minutes) for 'bash'; at least 3600 (1 hour) for 'agent'."
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
      kind,
      url,
      command,
      channelId,
      recurrence,
      intervalSeconds,
      timeOfDayMinutes,
      weekday,
    }) => {
      if (kind === 'script' && !url) {
        return {
          error: "kind 'script' requires a url.",
          success: false,
        };
      }
      if (kind === 'bash' && !command) {
        return {
          error: "kind 'bash' requires a command.",
          success: false,
        };
      }

      let schedule: ReminderSchedule;
      if (recurrence === 'interval') {
        if (intervalSeconds === undefined) {
          return {
            error: "recurrence 'interval' requires intervalSeconds.",
            success: false,
          };
        }
        const minInterval =
          MIN_INTERVAL_SECONDS_BY_KIND[kind] ?? MIN_INTERVAL_SECONDS_DEFAULT;
        if (intervalSeconds < minInterval) {
          return {
            error: `kind '${kind}' requires intervalSeconds >= ${minInterval}.`,
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

      let rawChannelId: string | undefined;
      if (channelId) {
        try {
          rawChannelId = toRawSlackChannelId(toChatSlackChannelId(channelId));
          await assertBotIsMember(rawChannelId);
        } catch (error) {
          return { error: errorMessage(error), success: false };
        }
      }

      try {
        const reminder = await createReminder({
          channelId: rawChannelId,
          command,
          kind,
          schedule,
          text,
          url,
          userId: message.author.userId,
        });
        return {
          id: reminder.id,
          nextRunAt: reminder.nextRunAt.toISOString(),
          success: true,
          summary: `Scheduled a recurring (${recurrence}, ${kind}) reminder${rawChannelId ? ` in <#${rawChannelId}>` : ' to your DMs'}. Next fires ${reminder.nextRunAt.toISOString()}. Auto-cancels after ${MAX_RECURRING_RUNS} runs.`,
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
      "List the current user's active recurring reminders, including their id (needed to cancel one).",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await listActiveReminders(message.author.userId);
      return {
        reminders: rows.map((row) => ({
          channelId: row.channelId ?? undefined,
          command: row.command ?? undefined,
          id: row.id,
          kind: row.kind,
          nextRunAt: row.nextRunAt.toISOString(),
          paused: row.paused,
          recurrence: row.recurrence,
          runsSoFar: row.runCount,
          runsRemaining: MAX_RECURRING_RUNS - row.runCount,
          schedule: describeSchedule(row),
          text: row.text,
          url: row.url ?? undefined,
        })),
        success: true,
      };
    },
  });
}

export function cancelReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Cancel one of the current user's recurring reminders by id (get the id from listReminders). This permanently deletes it; use pauseReminder instead to stop it temporarily.",
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

export function pauseReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Temporarily pause one of the current user's recurring reminders by id — the scheduler skips it until resumeReminder is called. Unlike cancelReminder, this does not delete it.",
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      const paused = await pauseReminderRow({
        id,
        userId: message.author.userId,
      });
      return paused
        ? { success: true }
        : {
            error: 'No matching active, unpaused reminder found for this user.',
            success: false,
          };
    },
  });
}

export function resumeReminderTool({ message }: { message: Message }) {
  return tool({
    description:
      "Resume one of the current user's paused recurring reminders by id. Recomputes the next fire time from now, so a long pause doesn't fire a backlog of missed runs.",
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      const resumed = await resumeReminderRow({
        id,
        userId: message.author.userId,
      });
      return resumed
        ? { success: true }
        : {
            error: 'No matching paused reminder found for this user.',
            success: false,
          };
    },
  });
}
