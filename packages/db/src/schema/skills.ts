import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Skills the OWNER installed or wrote (owner's ask, 2026-09-29, after coolton's
// skills). The built-in ones ship in the repo (apps/bot/src/skills); a row here
// with the same name replaces one. A skill is prompt text every user's turn can
// load, so only the owner writes here — see apps/bot/src/lib/skills.
export const skills = pgTable('skills', {
  name: text('name').primaryKey(),
  description: text('description').notNull(),
  body: text('body').notNull(),
  // Extra reference files the skill points at, by relative path.
  files: jsonb('files').$type<Record<string, string>>().notNull().default({}),
  // Where it was installed from, when it was not written here.
  source: text('source'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
