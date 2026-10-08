import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  type CurationChange,
  type MemoryCuration,
  memories,
  memoryCurations,
} from '../schema';

export type { CurationChange, MemoryCuration, MemorySnapshot } from '../schema';

/**
 * Authors due a curation pass: at least `minMemories` PRIVATE memories (the
 * owner curates what he promoted), and either never curated or curated before
 * `curatedBefore` with a memory changed since.
 */
export async function listAuthorsDueCuration({
  curatedBefore,
  minMemories,
}: {
  curatedBefore: Date;
  minMemories: number;
}): Promise<string[]> {
  const rows = await db.execute<{ author: string }>(sql`
    select m.created_by as author
    from ${memories} m
    left join (
      select author, max(ran_at) as last_run
      from ${memoryCurations}
      group by author
    ) c on c.author = m.created_by
    where m.is_global = false and m.scope_kind is null
    group by m.created_by, c.last_run
    having count(*) >= ${minMemories}
      and (c.last_run is null
        or (c.last_run < ${curatedBefore} and max(m.updated_at) > c.last_run))
  `);
  return rows.map((row) => row.author);
}

export async function recordMemoryCuration({
  author,
  changes,
}: {
  author: string;
  changes: CurationChange[];
}): Promise<void> {
  await db.insert(memoryCurations).values({ author, changes });
}

/** Curation passes for an author since `since`, newest first. */
export function listMemoryCurations({
  author,
  since,
}: {
  author: string;
  since: Date;
}): Promise<MemoryCuration[]> {
  return db
    .select()
    .from(memoryCurations)
    .where(
      and(eq(memoryCurations.author, author), gte(memoryCurations.ranAt, since))
    )
    .orderBy(desc(memoryCurations.ranAt));
}

/** "Erase my data": the curation log holds full memory text, so it goes too. */
export async function deleteMemoryCurationsByAuthor(
  author: string
): Promise<void> {
  await db.delete(memoryCurations).where(eq(memoryCurations.author, author));
}
