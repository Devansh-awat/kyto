import {
  createReminder,
  getReminder,
  isReminderEditableBy,
  type Reminder,
  type ReminderSchedule,
  updateReminder,
} from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import { publishHome } from '@/features/customizations/service';
import type { ModalSubmitEvent, ModalSubmitResult } from '@/harness/types';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { reminderChannelRefusal } from '@/lib/reminders/channel';
import { refreshEventReminders } from '@/lib/reminders/events';
import {
  buildSchedule,
  changesWhatReminderRuns,
  type ScheduleArgs,
} from '@/lib/reminders/rules';
import { fireReminder } from '@/lib/reminders/scheduler';
import { errorMessage, toLogError } from '@/lib/utils/error';
import {
  buildReminderModal,
  EVERY_UNITS,
  type EveryUnit,
  REMINDER_MODAL_CALLBACK,
  UNIT_SECONDS,
} from './views';

// Recurring AGENT reminders, created and edited from App Home; other kinds are
// changed by asking kyto (owner's call 2026-11-03). The same rules as the
// `reminders` tool (lib/reminders/rules + channel): the hourly floor, a channel
// only the creator and kyto are both in, and a named editor may re-time a job
// but never change its instructions, since it runs as its creator. Every id rides through the client, so access
// is re-checked when the modal opens AND when it is submitted.

const metadataSchema = z.object({ id: z.string().min(1) });
const unitSchema = z.enum(
  Object.keys(EVERY_UNITS) as [EveryUnit, ...EveryUnit[]]
);
const TIME = /^(\d{2}):(\d{2})$/;
const userTzSchema = z.object({
  user: z.object({ tz: z.string().optional() }).optional(),
});

const isOwnerUser = (userId: string): boolean =>
  Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;

function parseMetadata(text: string | undefined): string | undefined {
  if (!text) {
    return;
  }
  try {
    return metadataSchema.safeParse(JSON.parse(text)).data?.id;
  } catch {
    return;
  }
}

/** The reminder `userId` may edit, with whether they may change what it runs. */
async function editable({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<{ mayChangeRuns: boolean; reminder: Reminder } | undefined> {
  const reminder = await getReminder(id).catch(() => null);
  const isOwner = isOwnerUser(userId);
  if (
    !(
      reminder?.kind === 'agent' &&
      isReminderEditableBy(reminder, userId, isOwner)
    )
  ) {
    return;
  }
  return { mayChangeRuns: isOwner || reminder.userId === userId, reminder };
}

async function userTimezone(userId: string): Promise<string> {
  const info = await slack.webClient.users
    .info({ user: userId })
    .catch(() => undefined);
  return userTzSchema.safeParse(info).data?.user?.tz ?? 'UTC';
}

function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

async function openModal({
  id,
  triggerId,
  userId,
}: {
  id?: string;
  triggerId: string;
  userId: string;
}): Promise<void> {
  const found = id ? await editable({ id, userId }) : undefined;
  if (id && !found) {
    return;
  }
  const view = buildReminderModal({
    ...(found ? { existing: found.reminder } : {}),
    mayChangeRuns: found?.mayChangeRuns ?? true,
    timezone: await userTimezone(userId),
  });
  await slack.webClient.views
    .open({ trigger_id: triggerId, view: view as never })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId },
        '[reminders] could not open the editor'
      );
    });
}

bot.onAction('home_new_reminder', async (event) => {
  if (!event.triggerId) {
    return;
  }
  await openModal({ triggerId: event.triggerId, userId: event.user.userId });
});

bot.onAction('home_edit_reminder', async (event) => {
  if (!(event.value && event.triggerId)) {
    return;
  }
  await openModal({
    id: event.value,
    triggerId: event.triggerId,
    userId: event.user.userId,
  });
});

// One extra run now, to try a new prompt without waiting for the schedule. It
// does not count toward the run cap or move the next run.
bot.onAction('home_run_reminder', async (event) => {
  if (!event.value) {
    return;
  }
  const found = await editable({ id: event.value, userId: event.user.userId });
  if (!found) {
    return;
  }
  logger.info(
    { reminderId: found.reminder.id, userId: event.user.userId },
    '[reminders] run now from App Home'
  );
  await fireReminder({ bot, reminder: found.reminder }).catch(
    (error: unknown) => {
      logger.warn(
        { ...toLogError(error), reminderId: found.reminder.id },
        '[reminders] run now failed'
      );
    }
  );
});

/** The schedule the form describes, or the field to blame and why. */
function readSchedule(values: ModalSubmitEvent['values']):
  | {
      args: ScheduleArgs & {
        recurrence: NonNullable<ScheduleArgs['recurrence']>;
      };
    }
  | { block: string; error: string } {
  const unit = unitSchema.safeParse(values.reminder_every);
  if (!unit.success) {
    return { block: 'reminder_every', error: 'Pick how often.' };
  }
  const timezone = values.reminder_timezone?.trim() || 'UTC';
  if (!isTimezone(timezone)) {
    return {
      block: 'reminder_timezone',
      error: 'Not a timezone. Use an IANA name like Asia/Kolkata.',
    };
  }
  if (
    unit.data === 'minutes' ||
    unit.data === 'hours' ||
    unit.data === 'days'
  ) {
    const count = Number(values.reminder_count);
    if (!(Number.isInteger(count) && count >= 1)) {
      return { block: 'reminder_count', error: 'Say how many.' };
    }
    return {
      args: {
        intervalSeconds: count * UNIT_SECONDS[unit.data],
        recurrence: 'interval',
      },
    };
  }
  if (unit.data === 'cron') {
    const cron = values.reminder_cron?.trim();
    if (!cron) {
      return { block: 'reminder_cron', error: 'Write the cron expression.' };
    }
    return { args: { cron, recurrence: 'cron', timezone } };
  }
  const time = TIME.exec(values.reminder_time ?? '');
  if (!time) {
    return { block: 'reminder_time', error: 'Pick a time.' };
  }
  const [, hour, minute] = time;
  let day = '*';
  if (unit.data === 'weekly') {
    const weekday = values.reminder_weekday;
    if (!weekday) {
      return { block: 'reminder_weekday', error: 'Pick a day.' };
    }
    day = weekday;
  }
  // Saved as a cron in the person's timezone, so 9:00 stays 9:00 across DST.
  return {
    args: {
      cron: `${Number(minute)} ${Number(hour)} * * ${day}`,
      recurrence: 'cron',
      timezone,
    },
  };
}

const sameSchedule = (existing: Reminder, next: ReminderSchedule): boolean =>
  existing.recurrence === next.recurrence &&
  (next.recurrence !== 'interval' ||
    existing.intervalSeconds === next.intervalSeconds) &&
  (next.recurrence !== 'cron' ||
    (existing.cronExpression === next.cronExpression &&
      existing.timezone === next.timezone)) &&
  ((next.recurrence !== 'daily' && next.recurrence !== 'weekly') ||
    existing.timeOfDayMinutes === next.timeOfDayMinutes) &&
  (next.recurrence !== 'weekly' || existing.weekday === next.weekday);

bot.onModalSubmit(
  REMINDER_MODAL_CALLBACK,
  async (event: ModalSubmitEvent): Promise<ModalSubmitResult> => {
    const userId = event.user.userId;
    const id = parseMetadata(event.privateMetadata);
    const found = id ? await editable({ id, userId }) : undefined;
    if (id && !found) {
      return {
        action: 'errors',
        errors: {
          reminder_max_runs:
            'This reminder is gone, or you can no longer edit it.',
        },
      };
    }
    const existing = found?.reminder;
    const mayChangeRuns = found?.mayChangeRuns ?? true;
    const { values } = event;

    const kind = 'agent';
    const text = mayChangeRuns ? values.reminder_text?.trim() : undefined;
    if (mayChangeRuns && !text) {
      return {
        action: 'errors',
        errors: { reminder_text: 'Write the instructions.' },
      };
    }
    // Backstop: the modal never shows an editor the instructions field.
    if (
      existing &&
      !mayChangeRuns &&
      changesWhatReminderRuns({
        existing,
        ...(text === undefined ? {} : { text }),
      })
    ) {
      return {
        action: 'errors',
        errors: {
          reminder_max_runs:
            'Only the creator can change what this reminder runs.',
        },
      };
    }

    let nextSchedule: ReminderSchedule | undefined;
    if (existing?.recurrence !== 'event') {
      const read = readSchedule(values);
      if ('error' in read) {
        return { action: 'errors', errors: { [read.block]: read.error } };
      }
      const built = buildSchedule(read.args, kind);
      if (!built.ok) {
        return { action: 'errors', errors: { reminder_every: built.error } };
      }
      nextSchedule = built.schedule;
    }
    // Re-saving an unchanged schedule would restart its clock from now.
    const schedule =
      existing && nextSchedule && sameSchedule(existing, nextSchedule)
        ? undefined
        : nextSchedule;

    const channel = values.reminder_channel ?? null;
    // Checked against the CREATOR: the job posts as theirs, so an editor can't
    // send it somewhere its creator couldn't post.
    const channelRefusal =
      channel &&
      channel !== existing?.channelId &&
      (await reminderChannelRefusal({
        channelId: channel,
        userId: existing?.userId ?? userId,
      }));
    if (channelRefusal) {
      return { action: 'errors', errors: { reminder_channel: channelRefusal } };
    }
    const maxRunsText = values.reminder_max_runs?.trim();
    const maxRuns = maxRunsText ? Number(maxRunsText) : null;
    if (maxRuns !== null && !(Number.isInteger(maxRuns) && maxRuns >= 1)) {
      return {
        action: 'errors',
        errors: { reminder_max_runs: 'A whole number, 1 or more.' },
      };
    }
    const creatorId = existing?.userId ?? userId;
    const editors = (event.multiValues?.reminder_editors ?? []).filter(
      (editor) => editor !== creatorId
    );

    try {
      let saved: Reminder | null;
      if (existing) {
        saved = await updateReminder({
          id: existing.id,
          maxRuns,
          ...(text ? { text } : {}),
          ...(schedule ? { schedule } : {}),
          channelId: channel,
          ...(mayChangeRuns
            ? { editorUserIds: editors.length > 0 ? editors : null }
            : {}),
        });
      } else if (nextSchedule) {
        saved = await createReminder({
          channelId: channel,
          editorUserIds: editors.length > 0 ? editors : null,
          kind,
          maxRuns,
          schedule: nextSchedule,
          text: text ?? '',
          threadId: null,
          userId,
        });
      } else {
        return {
          action: 'errors',
          errors: { reminder_every: 'Pick how often.' },
        };
      }
      if (saved?.recurrence === 'event') {
        await refreshEventReminders();
      }
      logger.info(
        { created: !existing, kind, reminderId: saved?.id, userId },
        '[reminders] saved from App Home'
      );
    } catch (error) {
      logger.warn(
        { ...toLogError(error), userId },
        '[reminders] App Home save failed'
      );
      return {
        action: 'errors',
        errors: { reminder_every: `Couldn't save: ${errorMessage(error)}` },
      };
    }
    await publishHome({ userId }).catch(() => undefined);
    return;
  }
);
