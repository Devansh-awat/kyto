import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// People the bot owner has told kyto to stop answering.
//
// One row per user, replaced on a re-ban, deleted on an unban — a ban is a
// current state, not a history, and keeping expired rows around would mean
// keeping a list of who has ever annoyed the owner for no operational reason.
//
// `expiresAt` null means indefinite. The check is `expiresAt > now`, so a ban
// that has run out stops applying without anything having to sweep it.
export const bannedUsers = pgTable('banned_users', {
  userId: text('user_id').primaryKey(),
  // Why, in the owner's words. Required: a ban nobody can explain later is one
  // nobody can lift fairly.
  reason: text('reason').notNull(),
  // Null = until lifted by hand.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  bannedBy: text('banned_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BannedUser = typeof bannedUsers.$inferSelect;
