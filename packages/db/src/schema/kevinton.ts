import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Threads waiting for kevinton, kyto's after-the-fact reviewer (owner's ask,
// 2026-09-29, after coolton's). Every finished turn pushes `dueAt` 30 minutes
// out; once a thread has been quiet that long, one instance CLAIMS the row
// atomically and reviews what happened since `reviewedAt`. In the database, not
// a timer, because a redeploy every few hours would otherwise forget them all.
export const kevintonReviews = pgTable('kevinton_reviews', {
  threadId: text('thread_id').primaryKey(),
  lastActivityAt: timestamp('last_activity_at', {
    withTimezone: true,
  }).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
});
