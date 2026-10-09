import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A channel's standing instructions: rendered into every turn in that channel,
// before the asker's own (which win on a conflict). Set from App Home by the
// channel's creator or the owner, applied at once (owner's call 2026-10-09).
export const channelInstructions = pgTable('channel_instructions', {
  channelId: text('channel_id').primaryKey(),
  prompt: text('prompt').notNull(),
  // Who last saved it: the row's custodian in App Home, and what "Your data"
  // erases.
  setBy: text('set_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChannelInstructions = typeof channelInstructions.$inferSelect;
