import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// A turn kyto scheduled for itself in a thread (the `wake` tool, owner's ask
// 2026-10-31): nothing runs after a turn ends, so "I'll run it once the route
// is back" was a promise nobody kept until a bystander poked kyto six hours
// later (#164). At `wakeAt` the thread gets a new turn as `userId`, carrying
// `note`. In the DB so a restart doesn't lose it; the row is deleted as it
// fires.
export const threadWakes = pgTable(
  'thread_wakes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    threadId: text('thread_id').notNull(),
    // Whose turn scheduled it; the wake runs as them.
    userId: text('user_id').notNull(),
    // Scheduled by the user-account persona's turn, so it answers as that.
    asUserAccount: boolean('as_user_account').notNull().default(false),
    // How many wakes in a row this one ends: a wake turn may schedule the
    // next, and a chain past a limit is a loop (tools/wake.ts).
    chain: integer('chain').notNull().default(1),
    // kyto's own words on what to pick up.
    note: text('note').notNull(),
    wakeAt: timestamp('wake_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('thread_wakes_due_idx').on(table.wakeAt),
    index('thread_wakes_thread_idx').on(table.threadId),
  ]
);

export type ThreadWake = typeof threadWakes.$inferSelect;
