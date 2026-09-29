import { index, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// Every log line kyto emitted while working on a thread (owner's ask,
// 2026-09-29): kevinton debugs from these. Coolify's container logs are capped
// at 500 lines a read and start over at every redeploy — too little for kyto's
// verbose logs, and gone exactly when a turn died in a restart. Flushed in
// batches every few seconds, so a turn that dies mid-way still leaves its
// lines. Pruned after a week (apps/bot/src/lib/thread-logs.ts).
export const threadLogs = pgTable(
  'thread_logs',
  {
    id: serial('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // A batch of lines, newline-separated.
    lines: text('lines').notNull(),
  },
  (table) => [
    index('thread_logs_thread_idx').on(table.threadId, table.loggedAt),
  ]
);
