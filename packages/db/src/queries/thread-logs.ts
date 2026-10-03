import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../client';
import { threadLogs } from '../schema';
import { threadsInChannel } from './thread-ids';

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

/**
 * Delete the captured log lines of every thread rooted in one channel — for a
 * self-serve erase, so pass the user's own DM channel (the lines carry tool
 * inputs and results from those turns).
 */
export async function deleteThreadLogsForChannel(
  channelId: string
): Promise<void> {
  await db
    .delete(threadLogs)
    .where(threadsInChannel(threadLogs.threadId, channelId));
}

export async function pruneThreadLogs(before: Date): Promise<void> {
  await db.delete(threadLogs).where(lt(threadLogs.loggedAt, before));
}
