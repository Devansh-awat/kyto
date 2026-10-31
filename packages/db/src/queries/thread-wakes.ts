import { and, asc, eq, lte } from 'drizzle-orm';
import { db } from '../client';
import { type ThreadWake, threadWakes } from '../schema';

export async function createThreadWake(input: {
  asUserAccount: boolean;
  chain: number;
  note: string;
  threadId: string;
  userId: string;
  wakeAt: Date;
}): Promise<ThreadWake> {
  const [row] = await db.insert(threadWakes).values(input).returning();
  if (!row) {
    throw new Error('Saving the wake returned no row.');
  }
  return row;
}

export async function listThreadWakes(threadId: string): Promise<ThreadWake[]> {
  return await db
    .select()
    .from(threadWakes)
    .where(eq(threadWakes.threadId, threadId))
    .orderBy(asc(threadWakes.wakeAt));
}

/** Delete one wake of this thread; null if there was none by that id. */
export async function cancelThreadWake({
  id,
  threadId,
}: {
  id: string;
  threadId: string;
}): Promise<ThreadWake | null> {
  const [row] = await db
    .delete(threadWakes)
    .where(and(eq(threadWakes.id, id), eq(threadWakes.threadId, threadId)))
    .returning();
  return row ?? null;
}

/**
 * Take every wake that is due. A DELETE … RETURNING, so two instances polling
 * at once (a rolling deploy) can never both fire one.
 */
export async function claimDueThreadWakes(now: Date): Promise<ThreadWake[]> {
  return await db
    .delete(threadWakes)
    .where(lte(threadWakes.wakeAt, now))
    .returning();
}

/** "Your data": the wakes someone's turns scheduled. Returns how many. */
export async function deleteThreadWakesByUser(userId: string): Promise<number> {
  const rows = await db
    .delete(threadWakes)
    .where(eq(threadWakes.userId, userId))
    .returning({ id: threadWakes.id });
  return rows.length;
}
