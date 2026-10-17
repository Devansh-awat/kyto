import { desc, eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { type TurnTiming, turnTimings } from '../schema';

export type { TurnTiming } from '../schema';

export async function recordTurnTiming(
  row: Omit<TurnTiming, 'createdAt' | 'id'>
): Promise<void> {
  await db.insert(turnTimings).values(row);
}

/** A thread's most recent turns, newest first. */
export async function listTurnTimings({
  limit,
  threadId,
}: {
  limit: number;
  threadId: string;
}): Promise<TurnTiming[]> {
  return await db
    .select()
    .from(turnTimings)
    .where(eq(turnTimings.threadId, threadId))
    .orderBy(desc(turnTimings.createdAt))
    .limit(limit);
}

export async function pruneTurnTimings(olderThan: Date): Promise<void> {
  await db.delete(turnTimings).where(lt(turnTimings.createdAt, olderThan));
}
