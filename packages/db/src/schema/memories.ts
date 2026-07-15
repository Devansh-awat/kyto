import { pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

// Workspace-global memories: durable notes kyto writes for itself after solving
// a big or non-obvious task, so a LATER thread doesn't re-derive the same thing
// from scratch. Shared across every user and thread (not per-user) — a solved
// approach ("how a particular slider captcha decodes") is worth reusing.
//
// The `title` is the handle: every memory's title + one-line `summary` is
// injected into the system prompt so kyto knows what exists, then it fetches the
// full `body` only when a memory is actually relevant. Memories can be created
// and edited by the model, but NEVER deleted — there is deliberately no delete
// path, so an accumulated knowledge base can only grow.
export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    // Unique handle shown in the system prompt and used to fetch/edit.
    title: text('title').notNull(),
    // One line describing what's inside — shown alongside the title in the
    // prompt so kyto can judge relevance before spending tokens on the body.
    summary: text('summary').notNull(),
    // The full memory content, fetched on demand via fetchMemory.
    body: text('body').notNull(),
    // Slack user id of whoever's turn first created it (provenance only — anyone
    // may fetch or edit, since memories are workspace-global).
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique('memories_title_unique').on(table.title)]
);

export type Memory = typeof memories.$inferSelect;
