import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Per-thread subscription state for the custom Slack harness (replaces the
// chat-sdk's state-pg thread state). A row means kyto follows the thread;
// `respondOnThreadMessages` is what joinThread/mentions toggle.
export const threadSubscriptions = pgTable('thread_subscriptions', {
  // Harness thread id: `slack:CHANNEL:THREAD_TS`.
  threadId: text('thread_id').primaryKey(),
  respondOnThreadMessages: boolean('respond_on_thread_messages')
    .notNull()
    .default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadSubscription = typeof threadSubscriptions.$inferSelect;
