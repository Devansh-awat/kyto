import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// kyto's notebooks: one workspace-wide ('global') and one per Slack channel id,
// written only by kevinton. See apps/bot/src/lib/kevinton/notebook.ts.
export const notebooks = pgTable('notebooks', {
  scope: text('scope').primaryKey(),
  content: text('content').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
