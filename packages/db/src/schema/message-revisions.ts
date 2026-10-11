import { index, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// What a message said before it was edited, and what a deleted one said.
// Slack history only holds the latest text, so "do X", then an edit, then
// "you did it wrong" left kyto unable to see what it was actually asked; the
// same with a deleted message. Kept for threads kyto takes part in, human
// messages only, secrets redacted, reaped after 30 days
// (apps/bot/src/lib/message-revisions.ts).
export const messageRevisions = pgTable(
  'message_revisions',
  {
    id: serial('id').primaryKey(),
    channel: text('channel').notNull(),
    // The thread's root ts; a top-level message is its own root.
    rootTs: text('root_ts').notNull(),
    messageTs: text('message_ts').notNull(),
    userId: text('user_id').notNull(),
    kind: text('kind').$type<'deleted' | 'edited'>().notNull(),
    // The text BEFORE the edit, or of the deleted message.
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('message_revisions_thread_idx').on(table.channel, table.rootTs),
  ]
);

export type MessageRevision = typeof messageRevisions.$inferSelect;
