import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A thread's recent private reasoning, persisted so it survives a bot restart.
// Slack only records what kyto SAID; the reasoning behind it lived in the plan's
// Thinking cards and was otherwise gone, so a new turn re-derived the previous
// turn's conclusions and dead ends. Only the last few turns are kept (the module
// tail-clamps), and rows are reaped after ~a month so this stays a short-lived
// train of thought, not a permanent transcript.
/**
 * One turn's reasoning and tool observations. A turn that read someone's
 * private data (their DMs, private channels, email, their MCP servers) carries
 * `privateTo`: it is replayed in full only on that person's own turns. Plain
 * strings are rows written before that existed, treated as not private.
 */
export type StoredThinkingTurn = string | { privateTo: string; text: string };

export const threadThinking = pgTable('thread_thinking', {
  threadId: text('thread_id').primaryKey(),
  // The reasoning of the last few turns, oldest first (already tail-clamped).
  turns: jsonb('turns').$type<StoredThinkingTurn[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadThinking = typeof threadThinking.$inferSelect;
