import { and, eq, lte } from 'drizzle-orm';
import { db } from '../client';
import {
  type NewReminder,
  type Reminder,
  type ReminderKind,
  reminders,
} from '../schema';

export type { Reminder, ReminderKind, ReminderRecurrence } from '../schema';

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
  channelId?: string | null;
  maxRuns?: number | null;
  kind?: ReminderKind;
  command?: string | null;
  url?: string | null;
  threadId?: string | null;
}): Promise<Reminder> {
  const nextRunAt = computeNextRun(input.schedule, new Date());
  const values: NewReminder = {
    userId: input.userId,
    text: input.text,
    channelId: input.channelId ?? null,
    maxRuns: input.maxRuns ?? null,
    kind: input.kind ?? 'message',
    command: input.command ?? null,
    url: input.url ?? null,
    threadId: input.threadId ?? null,
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

/** All of a user's reminders, active and paused (for the management UI). */
export async function listUserReminders(userId: string): Promise<Reminder[]> {
  return await db.select().from(reminders).where(eq(reminders.userId, userId));
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

/** Pause a reminder (keeps it, just stops it firing). Scoped to its owner. */
export async function pauseReminder({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const updated = await db
    .update(reminders)
    .set({ active: false })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .returning({ id: reminders.id });
  return updated.length > 0;
}

/** Resume a paused reminder, snapping its next run to the future. */
export async function resumeReminder({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<boolean> {
  const [row] = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .limit(1);
  if (!row) {
    return false;
  }
  const now = new Date();
  const nextRunAt =
    row.nextRunAt > now ? row.nextRunAt : computeNextRun(scheduleOf(row), now);
  await db
    .update(reminders)
    .set({ active: true, nextRunAt })
    .where(eq(reminders.id, row.id));
  return true;
}

export async function getDueReminders(now: Date): Promise<Reminder[]> {
  return await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.active, true), lte(reminders.nextRunAt, now)));
}

/**
 * Advance a fired reminder to its next occurrence, incrementing its run count.
 * When a run cap is set and reached, the reminder is deactivated instead.
 *
 * The next run is computed from `nextRunAt` or from now, whichever is later. If
 * the scheduler was down (or a fire took a long time), a schedule left in the
 * past would otherwise fire again on every 30s poll until it caught up — a
 * harmless repeat for a 'message' reminder, but a burst of sandbox boots or
 * model calls for a 'bash'/'agent' one.
 */
export async function advanceReminder(reminder: Reminder): Promise<void> {
  const runCount = (reminder.runCount ?? 0) + 1;
  const capReached = reminder.maxRuns !== null && runCount >= reminder.maxRuns;
  if (capReached) {
    await db
      .update(reminders)
      .set({ active: false, runCount })
      .where(eq(reminders.id, reminder.id));
    return;
  }
  const now = new Date();
  const base = reminder.nextRunAt > now ? reminder.nextRunAt : now;
  const nextRunAt = computeNextRun(scheduleOf(reminder), base);
  await db
    .update(reminders)
    .set({ nextRunAt, runCount })
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
