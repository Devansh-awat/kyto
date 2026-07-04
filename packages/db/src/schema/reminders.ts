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

// 'message': posts `text` verbatim (the original behavior).
// 'script': fetches `url` and posts its content (optionally prefixed by `text`).
// 'agent': runs a small LLM (Gemini, the owner's own key) with `text` as its
// instructions, optionally fetching a URL itself, and posts whatever it decides.
// 'bash': runs `command` in a fresh E2B sandbox each fire and posts its exact
// stdout/stderr (optionally prefixed by `text`) — for real parsing/processing
// logic, unlike 'script' which only does a raw URL fetch.
export const reminderKind = pgEnum('reminder_kind', [
  'message',
  'script',
  'agent',
  'bash',
]);

export type ReminderKind = (typeof reminderKind.enumValues)[number];

export const reminders = pgTable(
  'reminders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull(),
    text: text('text').notNull(),
    recurrence: reminderRecurrence('recurrence').notNull(),
    kind: reminderKind('kind').notNull().default('message'),
    // Raw Slack channel id to post to (e.g. "C0123"); null means DM `userId`.
    channelId: text('channel_id'),
    // 'script' kind: the URL to fetch each run.
    url: text('url'),
    // 'bash' kind: the shell command to run in a fresh sandbox each run.
    command: text('command'),
    // Number of times this reminder has fired; recurring reminders stop
    // (deactivate) after MAX_RECURRING_RUNS regardless of kind.
    runCount: integer('run_count').notNull().default(0),
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
