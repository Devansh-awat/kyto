import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Turns that were running when this row was last touched, so a restart can pick
// them back up (owner's ask, 2026-09-29, from coolton). Every Coolify redeploy
// used to kill whatever kyto was halfway through, silently.
//
// One row per thread — a thread runs one turn at a time. The row is deleted
// when the turn ends normally; a shutdown marks it `interrupted` instead, and a
// crash leaves it `running` with a heartbeat that goes stale. A new instance
// CLAIMS such rows atomically (status → `resuming`, its own instance id), which
// is what stops the old and new containers of a rolling deploy from both
// running the same turn.
export interface InflightEffect {
  at: string;
  /** Compact, redacted input: enough to recognise it, not to redo it. */
  input: string;
  /** sha256 of the FULL input: an identical repeat is refused (#123). */
  inputHash?: string;
  /** Compact, redacted result — the link or id a resumed turn must quote back. */
  result?: string;
  status: 'done' | 'failed' | 'started';
  tool: string;
}

/**
 * Where a running turn had got to: its tool calls with their results and the
 * reply text already shown. A resumed turn continues from these as REAL
 * messages, like a fallback model does, instead of redoing the work.
 */
export interface InflightCheckpoint {
  at: string;
  results: { input: unknown; output: unknown; toolName: string }[];
  text: string;
}

export const inflightTurns = pgTable('inflight_turns', {
  threadId: text('thread_id').primaryKey(),
  messageId: text('message_id').notNull(),
  userId: text('user_id').notNull(),
  status: text('status', { enum: ['running', 'interrupted', 'resuming'] })
    .notNull()
    .default('running'),
  // Which process owns it right now (random per boot).
  instanceId: text('instance_id').notNull(),
  // Whether this run is a resumption (the turn runs quietly about it).
  resumed: boolean('resumed').notNull().default(false),
  // How many times it has been resumed — logged only: a turn is resumed after
  // every shutdown and every crash (owner's call 2026-10-31).
  resumes: integer('resumes').notNull().default(0),
  // Answered as kyto's Slack user account, not the app: resumed the same way.
  asUserAccount: boolean('as_user_account').notNull().default(false),
  // Outward actions this turn took (a post, an email, a deploy), each written
  // BEFORE it runs and marked after, so a turn resumed after a restart knows
  // which ones are done and which were cut mid-way (apps/bot/src/lib/agent/effects.ts).
  effects: jsonb('effects').$type<InflightEffect[]>().notNull().default([]),
  // Written every minute and when a shutdown cuts the turn (agent/inflight).
  checkpoint: jsonb('checkpoint').$type<InflightCheckpoint>(),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InflightTurn = typeof inflightTurns.$inferSelect;
