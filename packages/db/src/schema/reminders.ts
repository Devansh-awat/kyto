import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const reminderRecurrence = pgEnum('reminder_recurrence', [
  'interval',
  'daily',
  'weekly',
  'cron',
  // Fires on something happening rather than at a time (`trigger` below); its
  // `nextRunAt` sits in the far future so the time scheduler never picks it.
  'event',
]);

export type ReminderRecurrence = (typeof reminderRecurrence.enumValues)[number];

// What a reminder actually does each time it fires:
// 'message': posts `text` verbatim (the original, and still the default).
// 'script':  fetches `url` and posts its content, optionally prefixed by `text`.
// 'bash':    runs `command` in the sandbox of the thread it was created in
//            (`thread_id`) and posts its exact stdout/stderr. Because thread
//            sandboxes persist, this can use files the model wrote earlier.
// 'agent':   runs a headless kyto with `text` as its instructions, on the cheap
//            pinned model, and posts whatever it decides to say.
// Label order matches the live `reminder_kind` type, which predates this code
// (an earlier branch created it). Drizzle matches on label, not ordinal.
/**
 * What an 'event' reminder fires on (apps/bot/src/lib/reminders/events.ts).
 * Slack triggers need kyto in the channel; webhook ones are a secret URL kyto
 * hands back, and a GitHub one also checks GitHub's signature with the secret.
 */
export type ReminderTrigger =
  | {
      source: 'slack_message';
      channel: string;
      /** Only messages from this user (or bot user). */
      fromUser?: string;
      /** Case-insensitive substring, or a regex when `regex` is set. */
      pattern?: string;
      regex?: boolean;
      /** Only messages in this one thread (its root ts; the root counts). */
      threadTs?: string;
    }
  | {
      source: 'slack_reaction';
      channel: string;
      /** Emoji name without colons. */
      emoji?: string;
      fromUser?: string;
      /** Only reactions on this one message. */
      messageTs?: string;
      /**
       * Fire once per message when its reactions reach this many (of `emoji`
       * when set, else of every emoji), instead of on each reaction.
       */
      minReactions?: number;
      /** Only reactions on messages in this one thread. */
      threadTs?: string;
    }
  | {
      /** Fire once per thread when its replies reach `minReplies`. */
      source: 'slack_replies';
      channel: string;
      minReplies: number;
      /** Only this one thread. */
      threadTs?: string;
    }
  | { source: 'webhook' }
  | {
      source: 'github';
      /** `push`, `pull_request`, or `pull_request.opened`; empty = any. */
      events?: string[];
    };

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
    // Slack user ids allowed to edit/pause/cancel this reminder alongside its
    // creator. Empty = creator only. The bot owner may always edit anything.
    editorUserIds: jsonb('editor_user_ids').$type<string[]>(),
    text: text('text').notNull(),
    kind: reminderKind('kind').notNull().default('message'),
    // 'bash': the shell command to run each fire.
    command: text('command'),
    // 'script': the URL to fetch each fire.
    url: text('url'),
    // 'bash'/'agent': the thread this reminder was created in. A bash reminder
    // reuses that thread's persistent sandbox; an agent reminder posts into it
    // when no channel is set.
    threadId: text('thread_id'),
    // Where the reminder fires: a channel id (raw C…/G…) or null = DM the user.
    channelId: text('channel_id'),
    // Optional cap: stop (deactivate) after this many fires. Null = forever.
    maxRuns: integer('max_runs'),
    runCount: integer('run_count').notNull().default(0),
    recurrence: reminderRecurrence('recurrence').notNull(),
    // 'interval': how often to repeat, in seconds.
    intervalSeconds: integer('interval_seconds'),
    // 'daily' / 'weekly': minutes since UTC midnight the reminder fires at.
    timeOfDayMinutes: integer('time_of_day_minutes'),
    // 'weekly': 0 (Sunday) through 6 (Saturday), UTC.
    weekday: integer('weekday'),
    // 'cron': a five-field cron expression, read in `timezone` (IANA name).
    cronExpression: text('cron_expression'),
    timezone: text('timezone'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    // 'event' reminders only.
    trigger: jsonb('trigger').$type<ReminderTrigger>(),
    webhookSecret: text('webhook_secret'),
    // The cooldown's clock: two events a second apart fire once.
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
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

// A threshold trigger fires once per message or thread: the row is claimed
// before the fire, so the 13th reaction, a removed-and-re-added 12th, or a
// restart in between never fires it again.
export const reminderEventMarks = pgTable(
  'reminder_event_marks',
  {
    reminderId: text('reminder_id')
      .notNull()
      .references(() => reminders.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.reminderId, table.key] })]
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
