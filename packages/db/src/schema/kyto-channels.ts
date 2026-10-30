import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Channels each kyto — the app and its Slack user account — has been seen in,
// so a newly joined one is recognised (and the other kyto, plus the owner in a
// private one, invited) exactly once, across restarts. See
// apps/bot/src/features/channel-pairing.
export const kytoChannels = pgTable(
  'kyto_channels',
  {
    identity: text('identity').$type<'app' | 'user'>().notNull(),
    channelId: text('channel_id').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    // The latest join Slack reported live, and who did it: a removed kyto that
    // keeps coming back is otherwise untraceable, since a channel can hide its
    // join messages. No inviter on a join means kyto joined by itself.
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    inviter: text('inviter'),
  },
  (table) => [primaryKey({ columns: [table.identity, table.channelId] })]
);
