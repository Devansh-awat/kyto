import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Channels where kyto answers every top-level message without a mention, each in
// its own thread, with ONE sandbox shared by the whole channel (owner's ask,
// 2026-09-29, after coolton's code channels). See apps/bot/src/lib/code-channels.
export const codeChannels = pgTable('code_channels', {
  channelId: text('channel_id').primaryKey(),
  // Who turned it on: they, the channel's creator and the bot owner may turn
  // it off.
  enabledBy: text('enabled_by').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
