import { eq, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadThinking } from '../schema';

export type { ThreadThinking } from '../schema';

/**
 * The stored reasoning turns for a thread, or [] if none or the row is older
 * than maxAgeMs (a stale train of thought is worse context than none).
 */
export async function getThreadThinking(
  threadId: string,
  maxAgeMs: number
): Promise<string[]> {
  const [row] = await db
    .select()
    .from(threadThinking)
    .where(eq(threadThinking.threadId, threadId))
    .limit(1);
  if (!row) {
    return [];
  }
  if (Date.now() - row.updatedAt.getTime() > maxAgeMs) {
    return [];
  }
  return row.turns;
}

export async function saveThreadThinking(
  threadId: string,
  turns: string[]
): Promise<void> {
  await db
    .insert(threadThinking)
    .values({ threadId, turns })
    .onConflictDoUpdate({
      set: { turns, updatedAt: new Date() },
      target: threadThinking.threadId,
    });
}

export async function clearThreadThinking(threadId: string): Promise<void> {
  await db.delete(threadThinking).where(eq(threadThinking.threadId, threadId));
}

/** Reap rows whose reasoning is older than the retention window. */
export async function pruneThreadThinking(olderThan: Date): Promise<void> {
  await db
    .delete(threadThinking)
    .where(lt(threadThinking.updatedAt, olderThan));
}
