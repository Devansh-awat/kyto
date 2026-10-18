import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The deferred tools a thread has loaded and the order its tools array was last
// sent in (apps/bot/src/lib/ai/loaded-tools.ts). Kept across restarts because
// the tools array is the front of the cached prompt: losing either one on a
// deploy changed it, and the next turn read 0 from cache (measured 2026-10-17:
// 23 of 39 haiku turns' first request, gaps of minutes, in the 1h TTL).
export const threadLoadedTools = pgTable('thread_loaded_tools', {
  threadId: text('thread_id').primaryKey(),
  names: text('names').array().notNull(),
  toolOrder: text('tool_order').array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
