import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Channels where kyto answers every message without a mention, with ONE
// sandbox shared by the whole channel. See apps/bot/src/lib/code-channels.
export const codeChannels = pgTable('code_channels', {
  channelId: text('channel_id').primaryKey(),
  // Who turned it on (or asked for it): they, the channel's creator and the bot
  // owner may turn it off or archive it.
  enabledBy: text('enabled_by').notNull(),
  enabledAt: timestamp('enabled_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  // A real Slack code channel with kyto as its agent: the whole channel is one
  // conversation answered at the top level, and Slack's agents.* API (tabs,
  // context bar, commands, status) works there. False: an ordinary channel
  // turned into one, where each top-level message gets its own thread.
  native: boolean('native').notNull().default(false),
  // The thread kyto created it from (`slack:C…:ts`), when it did.
  originThreadId: text('origin_thread_id'),
  // Canvas tabs by kyto's own key. Slack keeps no view_key for a canvas tab and
  // leaves it out of listViews, so without this an update adds a second tab.
  // Parsed on read (apps/bot/src/lib/code-channels).
  canvasViews: jsonb('canvas_views').notNull().default({}),
});
