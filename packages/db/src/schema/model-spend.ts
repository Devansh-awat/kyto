import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Every paid model call, one row each, kept for good (owner's ask 2026-10-11:
// "why was ~$2.4 used today" had no answer — subagents never logged a cost,
// Kevinton's went to Coolify's 500 lines, and thread logs last a week).
// `source` says what spent it: turn, subagent, kevinton, compaction, recovery,
// jev, vision, … `owner`-only `!spend` reads it (apps/bot/src/lib/spend.ts).
export const modelSpend = pgTable(
  'model_spend',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    threadId: text('thread_id'),
    /** List price as the provider reported it; null when it reported none. */
    costUsd: doublePrecision('cost_usd'),
    inputTokens: integer('input_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Part of outputTokens: thinking. 0 where the provider reports none. */
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    /**
     * Per-step timing and amounts in tokens, chars and words (@repo/ai
     * call-stats), from 2026-10-17; null before, or when nothing was measured.
     */
    stats: jsonb('stats').$type<{ steps: object[] }>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('model_spend_created_idx').on(table.createdAt)]
);

export type ModelSpend = typeof modelSpend.$inferSelect;
