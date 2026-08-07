import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A user's own Slack authorization for kyto ("connect your Slack account"), one
 * row per user.
 *
 * kyto's bot token can only ever act as kyto. Some things it is asked to do are
 * only possible AS THE PERSON — deleting their own message is the first one
 * (`!secret`), and searching their channels or sending from their account are
 * the next. Those need a USER token, which only that person can grant.
 *
 * `encryptedToken` holds ONLY the bot's versioned ciphertext (`v1:…`, the same
 * AES-256-GCM scheme as a BYOK key, see `lib/byok/crypto.ts`), so this package
 * never sees a plaintext token and a `select *` or a query log cannot leak one.
 * Reads that don't need the secret use `getSlackGrant`, whose type omits it.
 */
export const userSlackGrants = pgTable('user_slack_grants', {
  userId: text('user_id').primaryKey(),
  // Encrypted Slack user token (`xoxp-…`).
  encryptedToken: text('encrypted_token').notNull(),
  // The scopes Slack actually granted, space-separated as Slack reports them.
  // Stored because the granted set can be NARROWER than the set requested (a
  // workspace can restrict them), and a feature that needs a missing scope
  // should say so rather than fail with a bare `missing_scope`.
  scopes: text('scopes').notNull(),
  teamId: text('team_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

type Row = typeof userSlackGrants.$inferSelect;

/** Everything about a grant EXCEPT the token — safe for UI and logs. */
export type SlackGrant = Omit<Row, 'encryptedToken'>;

/** The grant WITH its ciphertext, for the bot's resolver only. */
export type SlackGrantSecret = SlackGrant & { encryptedToken: string };
