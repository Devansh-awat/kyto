import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const reminderRecurrence = pgEnum('reminder_recurrence', [
  'interval',
  'daily',
  'weekly',
]);

export type ReminderRecurrence = (typeof reminderRecurrence.enumValues)[number];

export const reminders = pgTable(
  'reminders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    text: text('text').notNull(),
    recurrence: reminderRecurrence('recurrence').notNull(),
    // 'interval': how often to repeat, in seconds.
    intervalSeconds: integer('interval_seconds'),
    // 'daily' / 'weekly': minutes since UTC midnight the reminder fires at.
    timeOfDayMinutes: integer('time_of_day_minutes'),
    // 'weekly': 0 (Sunday) through 6 (Saturday), UTC.
    weekday: integer('weekday'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('reminders_due_idx').on(table.active, table.nextRunAt),
    index('reminders_user_idx').on(table.userId),
  ]
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
