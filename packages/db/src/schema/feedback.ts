import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// 👍/👎 on a kyto reply, from the buttons under it. One row per person per
// reply: clicking again changes the rating, and the optional comment from the
// modal is written onto the same row.
//
// The reply's TEXT is deliberately not copied here — the row points at the
// Slack message instead (channel + ts), so feedback never becomes a second,
// longer-lived transcript of someone's thread.
export const replyFeedback = pgTable(
  'reply_feedback',
  {
    channelId: text('channel_id').notNull(),
    // The footer message the buttons live on, directly under the reply.
    messageTs: text('message_ts').notNull(),
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    rating: text('rating', { enum: ['up', 'down'] }).notNull(),
    comment: text('comment'),
    // Which model wrote the reply — the thing a 👎 is most often about.
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.messageTs, table.userId] }),
  ]
);

export type ReplyFeedback = typeof replyFeedback.$inferSelect;
