import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A thread's private reasoning and tool results, persisted so it survives a bot
// restart. Slack only records what kyto SAID; the reasoning behind it lived in
// the plan's Thinking cards and was otherwise gone, so a new turn re-derived the
// previous turn's conclusions and dead ends. Kept for good; once it outgrows its
// budget the oldest turns are folded into a `summary` turn (lib/agent/thinking).
/**
 * One turn's reasoning and tool observations. A turn that read someone's
 * private data (their DMs, private channels, email, their MCP servers) carries
 * `privateTo`: it is replayed in full only on that person's own turns. Plain
 * strings are rows written before that existed, treated as not private.
 */
export type StoredThinkingTurn =
  | string
  | {
      /** What kyto DID that turn (tool calls, one line each), for compaction. */
      actions?: string;
      /** The Slack message the turn answered. */
      messageTs?: string;
      privateTo?: string;
      /** A summary of folded turns (text is the summary), not one turn. */
      summary?: boolean;
      /** The turn's reasoning. */
      text: string;
      /** Its tool calls and results. */
      tools?: string;
    };

export const threadThinking = pgTable('thread_thinking', {
  threadId: text('thread_id').primaryKey(),
  // Summaries first, then turns oldest first (reasoning tail-clamped).
  turns: jsonb('turns').$type<StoredThinkingTurn[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadThinking = typeof threadThinking.$inferSelect;
