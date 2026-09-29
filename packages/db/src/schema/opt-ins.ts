import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// People who accepted kyto's terms WITHOUT joining the opt-in channel.
//
// Membership of OPT_IN_CHANNEL is the normal consent record, rebuilt from Slack
// at every boot. Someone who clicked "opt in without joining" has no membership
// to rebuild from, so their acceptance lives here instead — without this row a
// restart would silently put them back behind the opt-in card.
export const optIns = pgTable('opt_ins', {
  userId: text('user_id').primaryKey(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
