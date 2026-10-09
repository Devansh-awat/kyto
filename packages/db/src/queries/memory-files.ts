import { eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { type MemoryFiles, memoryFiles } from '../schema';

export type { MemoryFiles } from '../schema';

export async function getMemoryFiles(
  memoryId: number
): Promise<MemoryFiles | undefined> {
  const [row] = await db
    .select()
    .from(memoryFiles)
    .where(eq(memoryFiles.memoryId, memoryId))
    .limit(1);
  return row;
}

/** Which of these memories carry files, without loading any archive. */
export async function memoryIdsWithFiles(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ memoryId: memoryFiles.memoryId })
    .from(memoryFiles)
    .where(inArray(memoryFiles.memoryId, ids));
  return new Set(rows.map((row) => row.memoryId));
}

export async function setMemoryFiles({
  archive,
  attachedBy,
  memoryId,
  paths,
}: {
  archive: Uint8Array;
  attachedBy: string;
  memoryId: number;
  paths: string[];
}): Promise<void> {
  const now = new Date();
  const values = {
    archive,
    attachedBy,
    bytes: archive.byteLength,
    paths,
    updatedAt: now,
  };
  await db
    .insert(memoryFiles)
    .values({ memoryId, ...values })
    .onConflictDoUpdate({ set: values, target: memoryFiles.memoryId });
}

/** Returns whether there was a folder to remove. */
export async function deleteMemoryFiles(memoryId: number): Promise<boolean> {
  const rows = await db
    .delete(memoryFiles)
    .where(eq(memoryFiles.memoryId, memoryId))
    .returning({ memoryId: memoryFiles.memoryId });
  return rows.length > 0;
}

/** What a memory's folder holds, without loading the archive itself. */
export async function getMemoryFileIndex(
  memoryId: number
): Promise<{ bytes: number; paths: string[] } | undefined> {
  const [row] = await db
    .select({ bytes: memoryFiles.bytes, paths: memoryFiles.paths })
    .from(memoryFiles)
    .where(eq(memoryFiles.memoryId, memoryId))
    .limit(1);
  return row;
}
