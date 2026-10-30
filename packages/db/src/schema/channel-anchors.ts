import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A poll or NPS survey card kept at the bottom of a channel: reposted under
// every new top-level message and pinned. One per channel; anchoring another
// replaces it. A poll's votes live in the card's own Slack metadata, so only
// the card's ts is kept here; a survey also names its `nps_surveys` row.
export const channelAnchors = pgTable('channel_anchors', {
  channelId: text('channel_id').primaryKey(),
  kind: text('kind', { enum: ['poll', 'nps'] }).notNull(),
  messageTs: text('message_ts').notNull(),
  surveyId: integer('survey_id'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChannelAnchor = typeof channelAnchors.$inferSelect;
