import {
  boolean,
  integer,
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
  // How many times it has been resumed. A CRASH is resumed at most once, so a
  // turn that crashes the process cannot crash every instance after it; a
  // clean shutdown is not the turn's fault and is resumed a few times — two
  // deploys a few minutes apart used to leave the turn dead after the second.
  resumes: integer('resumes').notNull().default(0),
  // Answered as kyto's Slack user account, not the app: resumed the same way.
  asUserAccount: boolean('as_user_account').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InflightTurn = typeof inflightTurns.$inferSelect;
