import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { type Memory, memories } from '../schema';

export type { Memory } from '../schema';

// Title + summary of every memory, oldest first — the lightweight index injected
// into the system prompt. The full body is fetched separately, on demand.
export interface MemoryIndexEntry {
  summary: string;
  title: string;
}

export async function listMemoryIndex(): Promise<MemoryIndexEntry[]> {
  return await db
    .select({ summary: memories.summary, title: memories.title })
    .from(memories)
    .orderBy(asc(memories.createdAt));
}

export async function getMemory(title: string): Promise<Memory | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(eq(memories.title, title))
    .limit(1);
  return row ?? null;
}

/**
 * Create a new memory. Returns null if a memory with that title already exists
 * (the caller should edit it instead) — saves are create-only so an existing
 * memory is never silently clobbered.
 */
export async function createMemory(input: {
  title: string;
  summary: string;
  body: string;
  createdBy: string;
}): Promise<Memory | null> {
  const [row] = await db
    .insert(memories)
    .values(input)
    .onConflictDoNothing({ target: memories.title })
    .returning();
  return row ?? null;
}

/**
 * Update an existing memory's summary and/or body. Only the fields passed are
 * touched. Returns the updated row, or null if no memory has that title.
 */
export async function updateMemory(input: {
  title: string;
  summary?: string;
  body?: string;
}): Promise<Memory | null> {
  const patch: { summary?: string; body?: string } = {};
  if (input.summary !== undefined) {
    patch.summary = input.summary;
  }
  if (input.body !== undefined) {
    patch.body = input.body;
  }
  if (Object.keys(patch).length === 0) {
    return await getMemory(input.title);
  }
  const [row] = await db
    .update(memories)
    .set(patch)
    .where(eq(memories.title, input.title))
    .returning();
  return row ?? null;
}
