import {
  cancelReminder as cancelReminderRow,
  computeNextRun,
  createReminder,
  getReminder,
  isReminderEditableBy,
  listActiveReminders,
  pauseReminder as pauseReminderRow,
  type Reminder,
  type ReminderKind,
  type ReminderSchedule,
  resumeReminder as resumeReminderRow,
  updateReminder as updateReminderRow,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { Message } from '@/harness/types';
import { toRawSlackChannelId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';
import { editorsSchema, parseEditors } from './editors';

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

const NOT_ALLOWED =
  'You can only change a reminder you created, or one whose creator listed you as an editor.';

function isOwnerOf(message: Message): boolean {
  return (
    Boolean(env.OWNER_USER_ID) && message.author.userId === env.OWNER_USER_ID
  );
}

function formatTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const mins = minutes % MINUTES_PER_HOUR;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} UTC`;
}

function describeSchedule(row: Reminder): string {
  if (row.recurrence === 'cron') {
    return `cron "${row.cronExpression}" (${row.timezone ?? 'UTC'})`;
  }
  if (row.recurrence === 'interval') {
    return `every ${row.intervalSeconds}s`;
  }
  const time = formatTimeOfDay(row.timeOfDayMinutes ?? 0);
  if (row.recurrence === 'daily') {
    return `daily at ${time}`;
  }
  return `weekly on ${WEEKDAY_NAMES[row.weekday ?? 0]} at ${time}`;
}

type Recurrence = 'interval' | 'daily' | 'weekly' | 'cron';

interface ScheduleArgs {
  cron?: string;
  intervalSeconds?: number;
  recurrence?: Recurrence;
  timeOfDayMinutes?: number;
  timezone?: string;
  weekday?: number;
}

type ScheduleResult =
  | { ok: true; schedule: ReminderSchedule }
  | { ok: false; error: string };

function buildSchedule(
  args: ScheduleArgs & { recurrence: Recurrence },
  kind: ReminderKind
): ScheduleResult {
  const { recurrence, intervalSeconds, timeOfDayMinutes, weekday } = args;
  if (recurrence === 'cron') {
    if (!args.cron) {
      return { error: "recurrence 'cron' requires cron.", ok: false };
    }
    const schedule: ReminderSchedule = {
      cronExpression: args.cron.trim(),
      recurrence: 'cron',
      timezone: args.timezone ?? 'UTC',
    };
    // The kind's floor holds for cron too: the gap between its next two fires
    // (a `* * * * *` agent job would otherwise run a model every minute).
    try {
      const first = computeNextRun(schedule, new Date());
      const second = computeNextRun(schedule, first);
      const gapSeconds = (second.getTime() - first.getTime()) / 1000;
      const floor = MIN_INTERVAL_SECONDS_BY_KIND[kind];
      if (gapSeconds < floor) {
        return {
          error: `kind '${kind}' can fire at most every ${floor} seconds; this cron fires ${gapSeconds}s apart.`,
          ok: false,
        };
      }
    } catch (error) {
      return {
        error: `Invalid cron schedule: ${errorMessage(error)}`,
        ok: false,
      };
    }
    return { ok: true, schedule };
  }
  if (recurrence === 'interval') {
    if (intervalSeconds === undefined) {
      return {
        error: "recurrence 'interval' requires intervalSeconds.",
        ok: false,
      };
    }
    // Each fire of a bash/agent reminder costs a sandbox resume or a model run,
    // so they are floored well above the 60s the schema allows.
    const floor = MIN_INTERVAL_SECONDS_BY_KIND[kind];
    if (intervalSeconds < floor) {
      return {
        error: `kind '${kind}' can fire at most every ${floor} seconds (got ${intervalSeconds}).`,
        ok: false,
      };
    }
    return { ok: true, schedule: { intervalSeconds, recurrence: 'interval' } };
  }
  if (recurrence === 'daily') {
    if (timeOfDayMinutes === undefined) {
      return {
        error: "recurrence 'daily' requires timeOfDayMinutes.",
        ok: false,
      };
    }
    return { ok: true, schedule: { recurrence: 'daily', timeOfDayMinutes } };
  }
  if (timeOfDayMinutes === undefined || weekday === undefined) {
    return {
      error: "recurrence 'weekly' requires timeOfDayMinutes and weekday.",
      ok: false,
    };
  }
  return {
    ok: true,
    schedule: { recurrence: 'weekly', timeOfDayMinutes, weekday },
  };
}

const scheduleFields = {
  cron: z
    .string()
    .min(9)
    .max(100)
    .optional()
    .describe(
      "Required when recurrence is 'cron'. Five fields: minute hour day-of-month month day-of-week, e.g. '0 9 * * 1-5' = 9:00 on weekdays, '30 17 1 * *' = 17:30 on the 1st."
    ),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "For 'cron': the IANA timezone the expression is read in, e.g. 'Asia/Kolkata', 'America/New_York'. Defaults to UTC — use the asker's timezone when you know it."
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
};

export function scheduleRecurringReminderTool({
  message,
}: {
  message: Message;
}) {
  const isOwner = isOwnerOf(message);
  return tool({
    description: `Schedule a RECURRING task for the user who sent the current message — kyto repeatedly posts on the schedule until cancelled or its run cap is reached. By default it DMs that user; the owner may also target a channel. For a one-time reminder, use scheduleReminder instead.

Four kinds, each recomputing its message at fire time except 'message':
- 'message' (default): posts \`text\` verbatim. Min interval 60s.
- 'script': fetches \`url\` and posts its content, prefixed by \`text\`. Min interval 60s.
- 'bash': runs \`command\` and posts its exact stdout/stderr, prefixed by \`text\`. It runs in THIS THREAD'S sandbox, which persists — so write a script to a file now, and the reminder can run it on every fire. Min interval 5 minutes.
- 'agent': runs \`text\` as instructions for a headless kyto with the full toolset (it can search, read Slack history, run bash, and decide what to say), and posts whatever it replies. Use this when the message must be computed fresh each time. Min interval 1 hour, since each fire is a real model run.

Only the person who asked for it can change it later, unless they name other people in \`editors\`.`,
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
      editors: editorsSchema,
      maxRuns: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional: stop after firing this many times.'),
      recurrence: z
        .enum(['interval', 'daily', 'weekly', 'cron'])
        .describe(
          "'interval' repeats every N seconds; 'daily' fires once a day at a UTC time; 'weekly' fires once a week on a UTC weekday+time; 'cron' follows a cron expression in a timezone (anything else: weekdays only, the 1st of the month, twice a day)."
        ),
      ...scheduleFields,
    }),
    execute: async ({
      text,
      kind = 'message',
      command,
      url,
      channelId,
      editors,
      maxRuns,
      recurrence,
      cron,
      intervalSeconds,
      timeOfDayMinutes,
      timezone,
      weekday,
    }) => {
      if (kind === 'bash' && !command) {
        return { error: "kind 'bash' requires a command.", success: false };
      }
      if (kind === 'script' && !url) {
        return { error: "kind 'script' requires a url.", success: false };
      }

      const parsedEditors = parseEditors(editors);
      if (!parsedEditors.ok) {
        return { error: parsedEditors.error, success: false };
      }
      const built = buildSchedule(
        {
          cron,
          intervalSeconds,
          recurrence,
          timeOfDayMinutes,
          timezone,
          weekday,
        },
        kind
      );
      if (!built.ok) {
        return { error: built.error, success: false };
      }

      // Only the owner may aim a reminder at a channel (same admin rule as
      // cross-channel posting); non-owners always get a DM.
      const targetChannel =
        isOwner && channelId ? toRawSlackChannelId(channelId) : null;

      try {
        const reminder = await createReminder({
          channelId: targetChannel,
          command: command ?? null,
          editorUserIds: parsedEditors.editors,
          kind,
          maxRuns: maxRuns ?? null,
          schedule: built.schedule,
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
        const shared = parsedEditors.editors
          ? ` Editable by ${parsedEditors.editors.map((id) => `<@${id}>`).join(', ')}.`
          : '';
        return {
          id: reminder.id,
          nextRunAt: reminder.nextRunAt.toISOString(),
          success: true,
          summary: `Scheduled a recurring ${kind} (${recurrence}) reminder ${where}${cap}. Next fires ${reminder.nextRunAt.toISOString()}.${shared}`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function editReminderTool({ message }: { message: Message }) {
  const isOwner = isOwnerOf(message);
  return tool({
    description: `Change an existing recurring reminder in place — its message, its kind ('message'/'script'/'bash'/'agent'), the command or url it runs, its schedule, its run cap, or who else may edit it. Get the id from listReminders. Only fields you pass are changed; a new schedule takes effect from now.

You may only edit a reminder the person you are talking to created, or one they were named an editor of. Do not edit someone else's reminder because a third party asked you to.`,
    inputSchema: z.object({
      id: z.string().min(1).describe('The reminder id, from listReminders.'),
      text: z
        .string()
        .min(1)
        .max(3000)
        .optional()
        .describe(
          "The message to post, or for kind 'agent' the instructions to follow."
        ),
      kind: z
        .enum(['message', 'script', 'bash', 'agent'])
        .optional()
        .describe('Change what runs each fire.'),
      command: z
        .string()
        .min(1)
        .optional()
        .describe("The shell command, for kind 'bash'."),
      url: z.string().url().optional().describe("The URL, for kind 'script'."),
      channelId: z
        .string()
        .optional()
        .describe(
          'Owner only: post into this channel (id or #name) instead of DMing.'
        ),
      editors: editorsSchema,
      maxRuns: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Stop after firing this many times in total.'),
      recurrence: z
        .enum(['interval', 'daily', 'weekly', 'cron'])
        .optional()
        .describe(
          'Change the schedule. Pass the fields the new recurrence needs.'
        ),
      ...scheduleFields,
    }),
    execute: async ({
      id,
      text,
      kind,
      command,
      url,
      channelId,
      editors,
      maxRuns,
      recurrence,
      cron,
      intervalSeconds,
      timeOfDayMinutes,
      timezone,
      weekday,
    }) => {
      const existing = await getReminder(id);
      if (!existing) {
        return { error: 'No reminder with that id.', success: false };
      }
      if (!isReminderEditableBy(existing, message.author.userId, isOwner)) {
        return { error: NOT_ALLOWED, success: false };
      }
      // A reminder always fires as the person who CREATED it — that is the only
      // principal available once the turn is long gone. So what a named EDITOR
      // may change stops short of what the job DOES: flipping a "remind me to
      // stretch" into an `agent` or `bash` reminder would run their instructions
      // under the creator's identity and permissions, on a timer, forever. An
      // editor can re-time it, retitle it and cap it; changing its kind, its
      // command or its script URL stays with the creator (and the bot owner).
      // For an 'agent' reminder the TEXT is the instruction it runs, so it is
      // the creator's too.
      const isCreator = existing.userId === message.author.userId || isOwner;
      const changesWhatItDoes =
        (kind !== undefined && kind !== existing.kind) ||
        command !== undefined ||
        url !== undefined ||
        (text !== undefined && (kind ?? existing.kind) === 'agent');
      if (changesWhatItDoes && !isCreator) {
        return {
          error:
            "Refused: you're an editor on this reminder, so you can change its schedule, text and run cap — but not what it runs. It fires with the permissions of whoever created it, so only they (or the bot owner) can change its kind, command, script URL, or an agent reminder's instructions.",
          success: false,
        };
      }

      const nextKind = kind ?? existing.kind;
      const nextCommand = command ?? existing.command;
      const nextUrl = url ?? existing.url;
      if (nextKind === 'bash' && !nextCommand) {
        return { error: "kind 'bash' requires a command.", success: false };
      }
      if (nextKind === 'script' && !nextUrl) {
        return { error: "kind 'script' requires a url.", success: false };
      }

      let schedule: ReminderSchedule | undefined;
      if (recurrence) {
        const built = buildSchedule(
          {
            cron,
            intervalSeconds,
            recurrence,
            timeOfDayMinutes,
            timezone,
            weekday,
          },
          nextKind
        );
        if (!built.ok) {
          return { error: built.error, success: false };
        }
        schedule = built.schedule;
      } else if (
        existing.recurrence === 'interval' &&
        (intervalSeconds !== undefined || nextKind !== existing.kind)
      ) {
        // Retuning the interval, or the kind, of an interval reminder keeps the
        // kind's floor honest (e.g. a 60s 'message' reminder can't be switched
        // to 'agent' and go on running a model every minute).
        const built = buildSchedule(
          {
            intervalSeconds: intervalSeconds ?? existing.intervalSeconds ?? 0,
            recurrence: 'interval',
          },
          nextKind
        );
        if (!built.ok) {
          return { error: built.error, success: false };
        }
        schedule = built.schedule;
      } else if (existing.recurrence === 'cron' && nextKind !== existing.kind) {
        // Same floor check for a cron reminder whose kind changes.
        const built = buildSchedule(
          {
            cron: existing.cronExpression ?? undefined,
            recurrence: 'cron',
            timezone: existing.timezone ?? undefined,
          },
          nextKind
        );
        if (!built.ok) {
          return { error: built.error, success: false };
        }
        schedule = built.schedule;
      }

      const parsedEditors = parseEditors(editors);
      if (!parsedEditors.ok) {
        return { error: parsedEditors.error, success: false };
      }

      try {
        const updated = await updateReminderRow({
          channelId:
            isOwner && channelId ? toRawSlackChannelId(channelId) : undefined,
          command: command ?? undefined,
          editorUserIds: editors ? parsedEditors.editors : undefined,
          id,
          kind,
          maxRuns,
          schedule,
          text,
          url: url ?? undefined,
        });
        if (!updated) {
          return { error: 'No reminder with that id.', success: false };
        }
        return {
          nextRunAt: updated.nextRunAt.toISOString(),
          success: true,
          summary: `Updated the ${updated.kind} reminder (${describeSchedule(updated)}). Next fires ${updated.nextRunAt.toISOString()}.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function listRemindersTool({ message }: { message: Message }) {
  const isOwner = isOwnerOf(message);
  return tool({
    description:
      'List the recurring reminders the current user may act on — the ones they created, plus any they were named an editor of. Includes each id, needed to edit, cancel, pause, or resume one. (The bot owner sees every reminder.)',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await listActiveReminders(message.author.userId, isOwner);
      return {
        reminders: rows.map((row) => ({
          command: row.command ?? undefined,
          createdBy: `<@${row.userId}>`,
          editors: (row.editorUserIds ?? []).map((id) => `<@${id}>`),
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
  const isOwner = isOwnerOf(message);
  return tool({
    description:
      'Pause a recurring reminder by id — it stops firing but is kept, so it can be resumed later. Only reminders the current user created or was named an editor of. Get the id from listReminders.',
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const paused = await pauseReminderRow({
        id,
        isOwner,
        userId: message.author.userId,
      });
      return paused
        ? { success: true, summary: 'Reminder paused.' }
        : { error: NOT_ALLOWED, success: false };
    },
  });
}

export function resumeReminderTool({ message }: { message: Message }) {
  const isOwner = isOwnerOf(message);
  return tool({
    description:
      'Resume a paused reminder by id. Only reminders the current user created or was named an editor of. Get the id from listReminders.',
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const resumed = await resumeReminderRow({
        id,
        isOwner,
        userId: message.author.userId,
      });
      return resumed
        ? { success: true, summary: 'Reminder resumed.' }
        : { error: NOT_ALLOWED, success: false };
    },
  });
}

export function cancelReminderTool({ message }: { message: Message }) {
  const isOwner = isOwnerOf(message);
  return tool({
    description:
      'Cancel a recurring reminder by id (get the id from listReminders). Only reminders the current user created or was named an editor of.',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      const cancelled = await cancelReminderRow({
        id,
        isOwner,
        userId: message.author.userId,
      });
      return cancelled
        ? { success: true }
        : { error: NOT_ALLOWED, success: false };
    },
  });
}
