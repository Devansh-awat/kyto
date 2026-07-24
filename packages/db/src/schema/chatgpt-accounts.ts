import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A user's linked ChatGPT account ("Sign in with ChatGPT"), one row per user.
 *
 * `encryptedTokens` holds ONLY the bot's versioned ciphertext (`v1:…`, the same
 * AES-256-GCM scheme as a BYOK key, see `lib/byok/crypto.ts`) — a JSON blob of
 * the OAuth access/refresh tokens and the account id. This package never sees a
 * plaintext token, so a query log or a `select *` cannot leak one. Reads that
 * don't need the secret must use `getChatgptAccount`, whose return type omits
 * it; only the bot's resolver calls `getChatgptAccountSecret`.
 */
export const userChatgptAccounts = pgTable('user_chatgpt_accounts', {
  userId: text('user_id').primaryKey(),
  // Encrypted JSON: { accessToken, refreshToken, idToken, accountId, expiresAt }.
  encryptedTokens: text('encrypted_tokens').notNull(),
  // The account's email (or a fallback label), for the App Home UI. Not a secret.
  accountLabel: text('account_label').notNull(),
  // The model id to run for this user's turns.
  model: text('model').notNull(),
  // Ordering: run the ChatGPT account BEFORE kyto's shared models (true, the
  // default — their subscription pays) or only AFTER the shared chain (false).
  chatgptFirst: boolean('chatgpt_first').notNull().default(true),
  // May kyto fall back to the SHARED service budget when the ChatGPT account
  // fails? Off by default, same rule as BYOK: a broken personal login must not
  // silently spend the shared budget. Ignored when chatgptFirst is false (the
  // shared chain already runs first in that mode).
  serviceFallback: boolean('service_fallback').notNull().default(false),
  validationStatus: text('validation_status').notNull().default('unvalidated'),
  validationMessage: text('validation_message'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

type Row = typeof userChatgptAccounts.$inferSelect;

/** Everything about a linked account EXCEPT the tokens — safe for UI and logs. */
export type ChatgptAccount = Omit<Row, 'encryptedTokens'>;

/** The account WITH its encrypted token blob, for the bot resolver only. */
export type ChatgptAccountSecret = ChatgptAccount & {
  encryptedTokens: string;
};
