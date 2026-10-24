import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// A compacted summary of the part of a Slack thread that no longer fits in the
// prompt. buildPrompt replays the thread as kyto's only memory of it, capped at
// the most recent N messages — past that the oldest simply vanished, with the
// model never told anything was missing. This row is what those messages became.
//
// Written incrementally: each turn folds only the messages that have newly
// fallen out of the replay window into the existing summary, so a long thread
// costs one small call occasionally rather than re-summarizing itself forever.
// Reaped on the same ~month retention as thread_thinking — it is derived text
// about a conversation, held for the same reason and for no longer.
export const threadSummaries = pgTable('thread_summaries', {
  // How many messages the summary accounts for, so the prompt can say so.
  coveredCount: integer('covered_count').notNull(),
  summary: text('summary').notNull(),
  threadId: text('thread_id').primaryKey(),
  // Id of the newest message folded in. Everything after it is either still
  // replayed verbatim or waiting to be compacted on a later turn.
  throughMessageId: text('through_message_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ThreadSummary = typeof threadSummaries.$inferSelect;

// What the last turn's first request in a thread REALLY cost, as the provider
// reported it, and how many characters that request was. buildPrompt compacts
// from this, never from an estimate (owner's call, 2026-10-14): only when the
// real count reached its threshold, and only as many of the oldest messages as
// the measured tokens-per-character says will bring it back down.
export const threadPromptSizes = pgTable('thread_prompt_sizes', {
  // The first message replayed in that request, so a window that has already
  // been cut since is not cut again on the same (now stale) measurement.
  firstReplayedId: text('first_replayed_id'),
  inputTokens: integer('input_tokens').notNull(),
  requestChars: integer('request_chars').notNull(),
  // How much of requestChars was the <your_previous_thinking> block, so the
  // measured excess is split between history and thinking by their share.
  thinkingChars: integer('thinking_chars').notNull().default(0),
  threadId: text('thread_id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
