import {
  index,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** One memory as it was before a curation pass changed or removed it. */
export interface MemorySnapshot {
  body: string;
  id: number;
  summary: string;
  title: string;
}

export interface CurationChange {
  action: 'merge' | 'remove';
  /** For a merge: the memory that absorbed the others, as it was before. */
  keptBefore?: MemorySnapshot;
  reason: string;
  /** Deleted by this change: the absorbed memories, or the stale one. */
  removed: MemorySnapshot[];
}

// The periodic memory curation's audit trail (lib/memory-curation). Every merge
// and removal keeps the full text of what it replaced, so the `memory` tool's
// `restore` can bring a memory back by title, and the last pass per author is
// what decides when the next one is due.
export const memoryCurations = pgTable(
  'memory_curations',
  {
    id: serial('id').primaryKey(),
    author: text('author').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    changes: jsonb('changes').$type<CurationChange[]>().notNull(),
  },
  (table) => [index('memory_curations_author_idx').on(table.author)]
);

export type MemoryCuration = typeof memoryCurations.$inferSelect;
