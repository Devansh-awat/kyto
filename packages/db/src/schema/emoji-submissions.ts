import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Who asked for each custom emoji kyto added DIRECTLY (under its shared user
// account). Slack only lets the adding account remove an emoji, so removal runs
// under that one account — which is why it can't be wide open. This row is what
// lets the person who requested an emoji remove it later (and no one else, bar
// the owner): without it "remove it" would mean anyone could delete anything
// kyto ever added for anyone.
export const emojiSubmissions = pgTable('emoji_submissions', {
  name: text('name').primaryKey(),
  requestedBy: text('requested_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
