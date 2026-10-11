import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Where each turn's time went, kept 30 days (apps/bot/src/lib/turn-timings.ts).
// The same numbers are on the `turn complete` log line, but thread logs last a
// week and Coolify's 500 lines reset at every deploy, so "was it slower before
// the switch to haiku" had nothing to compare against.
export const turnTimings = pgTable(
  'turn_timings',
  {
    id: serial('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    messageTs: text('message_ts').notNull(),
    outcome: text('outcome').$type<'complete' | 'failed' | 'interrupted'>(),
    totalMs: integer('total_ms').notNull(),
    timing: jsonb('timing').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('turn_timings_thread_idx').on(table.threadId, table.createdAt),
  ]
);

export type TurnTiming = typeof turnTimings.$inferSelect;
