import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// A named set of Slack channels, so a configuration written once applies to all
// of them (owner's ask 2026-08-21: "if many linked channels, then i can link
// same mem and mcp with all 5-7 channels").
//
// ANYONE may create a group — the owner's call. The creator is its custodian:
// only they (and the bot owner) can rename it, delete it, or change which
// channels are in it. That matters because a group is what other people's
// shares point AT: if someone shares their own MCP server with group `hq`,
// adding a channel to `hq` extends that share to the new channel. Sharing with
// a group is therefore trust in the group's custodian, and the App Home UI says
// so at the point of sharing.
export const channelGroups = pgTable(
  'channel_groups',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Stored lower-cased so `HQ` and `hq` cannot be two groups; the namespace is
    // workspace-wide, since the whole point is that several people point at the
    // same group by name.
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('channel_groups_name_unique').on(table.name)]
);

export const channelGroupChannels = pgTable(
  'channel_group_channels',
  {
    groupId: text('group_id').notNull(),
    channelId: text('channel_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.groupId, table.channelId],
      name: 'channel_group_channels_pk',
    }),
  ]
);

export type ChannelGroup = typeof channelGroups.$inferSelect;
export type ChannelGroupChannel = typeof channelGroupChannels.$inferSelect;
