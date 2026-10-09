import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { memories } from './memories';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

// A folder attached to a memory (the `memory` tool's `attach`): a gzipped tar,
// at most 5 MB (owner's call 2026-10-09), restored into a sandbox on request.
// Goes with its memory (cascade) — erase, delete and curation never orphan one.
export const memoryFiles = pgTable('memory_files', {
  memoryId: integer('memory_id')
    .primaryKey()
    .references(() => memories.id, { onDelete: 'cascade' }),
  archive: bytea('archive').notNull(),
  bytes: integer('bytes').notNull(),
  // The archive's file paths (capped), so listing never unpacks it.
  paths: jsonb('paths').$type<string[]>().notNull(),
  attachedBy: text('attached_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type MemoryFiles = typeof memoryFiles.$inferSelect;
