import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A thread's `!with <model>` / `!reasoning <effort>` choice, sticky until
// cleared. Kept apart from thread_subscriptions because a row there means
// "kyto follows this thread", and choosing a model must not subscribe it.
export const threadModelChoices = pgTable('thread_model_choices', {
  threadId: text('thread_id').primaryKey(),
  /**
   * A `MODEL_CHOICES` key (apps/bot/src/lib/agent/model-choice.ts), or any slug
   * for the person who set it to run on their own key; null = default.
   */
  model: text('model'),
  // A slug runs on THIS person's own key only — never on whoever speaks next.
  modelSetBy: text('model_set_by'),
  /** none/low/medium/high; null = the default (random for the experiment models). */
  reasoningEffort: text('reasoning_effort'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadModelChoiceRow = typeof threadModelChoices.$inferSelect;
