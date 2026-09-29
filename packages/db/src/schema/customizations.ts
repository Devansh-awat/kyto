import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const userCustomizations = pgTable('user_customizations', {
  userId: text('user_id').primaryKey(),
  prompt: text('prompt').notNull(),
  // Whether to append the per-turn reply footer (time taken + 👍/👎) under
  // Kyto's replies for this user. Opt-out toggle from the App Home tab.
  showUsageFooter: boolean('show_usage_footer').notNull().default(true),
  // Which models this person's turns run on, once they have a key of their
  // own: 'own' (theirs first — the default, and the behavior before this
  // existed), 'shared' (kyto's only; their keys stay unused), or 'coding'
  // (kyto's normally, theirs when the turn is coding work). Null = 'own'.
  modelMode: text('model_mode', { enum: ['own', 'shared', 'coding'] }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UserCustomization = Pick<
  typeof userCustomizations.$inferSelect,
  'modelMode' | 'prompt' | 'showUsageFooter'
>;

export type ModelMode = NonNullable<
  (typeof userCustomizations.$inferSelect)['modelMode']
>;
