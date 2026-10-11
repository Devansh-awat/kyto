import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { type DebugSnapshot, debugSnapshots } from '../schema';

export type { DebugSnapshot } from '../schema';

export async function saveDebugSnapshot(
  snapshot: Omit<DebugSnapshot, 'createdAt'>
): Promise<void> {
  await db.insert(debugSnapshots).values(snapshot);
}

export async function getDebugSnapshot(
  id: string
): Promise<DebugSnapshot | undefined> {
  const [row] = await db
    .select()
    .from(debugSnapshots)
    .where(eq(debugSnapshots.id, id))
    .limit(1);
  return row;
}

export async function pruneDebugSnapshots(olderThan: Date): Promise<void> {
  await db
    .delete(debugSnapshots)
    .where(lt(debugSnapshots.createdAt, olderThan));
}
