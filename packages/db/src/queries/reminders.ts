import { and, eq, lte } from 'drizzle-orm';
import { db } from '../client';
import { type NewReminder, type Reminder, reminders } from '../schema';

export type { Reminder, ReminderRecurrence } from '../schema';

const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_WEEK = 7;
const MS_PER_SECOND = 1000;

export type ReminderSchedule =
  | { recurrence: 'interval'; intervalSeconds: number }
  | { recurrence: 'daily'; timeOfDayMinutes: number }
  | { recurrence: 'weekly'; timeOfDayMinutes: number; weekday: number };

/** Compute the next fire time for a schedule, strictly after `from`. */
export function computeNextRun(schedule: ReminderSchedule, from: Date): Date {
  if (schedule.recurrence === 'interval') {
    return new Date(from.getTime() + schedule.intervalSeconds * MS_PER_SECOND);
  }

  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCMinutes(schedule.timeOfDayMinutes);

  if (schedule.recurrence === 'daily') {
    if (next <= from) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  // weekly
  let dayDelta =
    (schedule.weekday - next.getUTCDay() + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  next.setUTCDate(next.getUTCDate() + dayDelta);
  if (next <= from) {
    dayDelta = DAYS_PER_WEEK;
    next.setUTCDate(next.getUTCDate() + dayDelta);
  }
  return next;
}

export async function createReminder(input: {
  userId: string;
  text: string;
  schedule: ReminderSchedule;
}): Promise<Reminder> {
  const nextRunAt = computeNextRun(input.schedule, new Date());
  const values: NewReminder = {
    userId: input.userId,
    text: input.text,
    recurrence: input.schedule.recurrence,
    nextRunAt,
    ...(input.schedule.recurrence === 'interval'
      ? { intervalSeconds: input.schedule.intervalSeconds }
      : { timeOfDayMinutes: input.schedule.timeOfDayMinutes }),
    ...(input.schedule.recurrence === 'weekly'
      ? { weekday: input.schedule.weekday }
      : {}),
  };
  const [row] = await db.insert(reminders).values(values).returning();
  if (!row) {
    throw new Error('Failed to create reminder.');
  }
  return row;
}

export async function listActiveReminders(userId: string): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.active, true)));
}

export async function cancelReminder({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .returning({ id: reminders.id });
  return deleted.length > 0;
}

export async function getDueReminders(now: Date): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.active, true), lte(reminders.nextRunAt, now)));
}

/** Advance a fired reminder to its next occurrence. */
export async function advanceReminder(reminder: Reminder): Promise<void> {
  const schedule = scheduleOf(reminder);
  const nextRunAt = computeNextRun(schedule, reminder.nextRunAt);
  await db
    .update(reminders)
    .set({ nextRunAt })
    .where(eq(reminders.id, reminder.id));
}

function scheduleOf(reminder: Reminder): ReminderSchedule {
  if (reminder.recurrence === 'interval') {
    return {
      recurrence: 'interval',
      intervalSeconds: reminder.intervalSeconds ?? MINUTES_PER_DAY * 60,
    };
  }
  if (reminder.recurrence === 'weekly') {
    return {
      recurrence: 'weekly',
      timeOfDayMinutes: reminder.timeOfDayMinutes ?? 0,
      weekday: reminder.weekday ?? 0,
    };
  }
  return {
    recurrence: 'daily',
    timeOfDayMinutes: reminder.timeOfDayMinutes ?? 0,
  };
}
