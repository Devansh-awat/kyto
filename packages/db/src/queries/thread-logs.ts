import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadLogs } from '../schema';

export async function appendThreadLogs(
  batches: { lines: string; threadId: string }[]
): Promise<void> {
  if (batches.length > 0) {
    await db.insert(threadLogs).values(batches);
  }
}

/** A thread's log lines, oldest first, optionally only since `since`. */
export async function readThreadLogs({
  since,
  threadId,
}: {
  since?: Date;
  threadId: string;
}): Promise<{ lines: string; loggedAt: Date }[]> {
  return await db
    .select({ lines: threadLogs.lines, loggedAt: threadLogs.loggedAt })
    .from(threadLogs)
    .where(
      since
        ? and(
            eq(threadLogs.threadId, threadId),
            gte(threadLogs.loggedAt, since)
          )
        : eq(threadLogs.threadId, threadId)
    )
    .orderBy(asc(threadLogs.loggedAt), asc(threadLogs.id));
}

export async function pruneThreadLogs(before: Date): Promise<void> {
  await db.delete(threadLogs).where(lt(threadLogs.loggedAt, before));
}
