import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Per-message-type presentation for kyto: an optional name SUFFIX (the base name
// is always "kyto" — it can never be renamed to something else) and an optional
// icon (a Slack `:emoji:` code or an image URL). Configured by the owner from
// the App Home tab and applied when kyto posts that kind of message (a reminder
// DM, a subagent's block, etc.).
export const identityProfiles = pgTable('identity_profiles', {
  // 'normal' | 'subagent' | 'reminder'.
  messageType: text('message_type').primaryKey(),
  nameSuffix: text('name_suffix'),
  icon: text('icon'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type IdentityProfile = typeof identityProfiles.$inferSelect;
