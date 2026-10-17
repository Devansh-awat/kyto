import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The reasoning effort a thread's luna attempts run at, once Jev has raised it
// above the thread's hashed draw (apps/bot/src/lib/ai/tool-preload.ts). Luna
// keeps a separate prompt cache per effort, so the effort only ever goes up:
// a thread that bounced between levels would re-write its whole cache each time.
export const threadLunaEfforts = pgTable('thread_luna_efforts', {
  threadId: text('thread_id').primaryKey(),
  effort: text('effort').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
