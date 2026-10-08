import { Cron } from 'croner';

// No database here, so the schedule math is testable without a connection.

const DAYS_PER_WEEK = 7;
const MS_PER_SECOND = 1000;

export type ReminderSchedule =
  | { recurrence: 'interval'; intervalSeconds: number }
  | { recurrence: 'daily'; timeOfDayMinutes: number }
  | { recurrence: 'weekly'; timeOfDayMinutes: number; weekday: number }
  | { recurrence: 'cron'; cronExpression: string; timezone: string };

/** Compute the next fire time for a schedule, strictly after `from`. */
export function computeNextRun(schedule: ReminderSchedule, from: Date): Date {
  if (schedule.recurrence === 'cron') {
    const next = new Cron(schedule.cronExpression, {
      paused: true,
      timezone: schedule.timezone,
    }).nextRun(from);
    if (!next) {
      throw new Error(
        `The cron expression "${schedule.cronExpression}" never fires again.`
      );
    }
    return next;
  }
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
