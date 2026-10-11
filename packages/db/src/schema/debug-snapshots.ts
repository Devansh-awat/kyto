import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A frozen copy of what kyto knew and did in one thread, taken by the owner's
// `!debug` (apps/bot/src/lib/debug-snapshot.ts) and viewed on the dashboard.
// Never updated after it is written: the point is a record that still says
// what it said after the thread, the logs and the reasoning have moved on.
export const debugSnapshots = pgTable('debug_snapshots', {
  // Random, so the dashboard URL can't be walked.
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull(),
  createdBy: text('created_by').notNull(),
  body: jsonb('body').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DebugSnapshot = typeof debugSnapshots.$inferSelect;
