import { and, eq, gt } from 'drizzle-orm';
import { db } from '../client';
import { threadLunaEfforts } from '../schema/thread-luna-efforts';

/** The thread's luna effort, if luna last ran there after `since`. */
export async function getThreadLunaEffort({
  since,
  threadId,
}: {
  since: Date;
  threadId: string;
}): Promise<string | undefined> {
  const [row] = await db
    .select({ effort: threadLunaEfforts.effort })
    .from(threadLunaEfforts)
    .where(
      and(
        eq(threadLunaEfforts.threadId, threadId),
        gt(threadLunaEfforts.updatedAt, since)
      )
    );
  return row?.effort;
}

export async function saveThreadLunaEffort({
  effort,
  threadId,
}: {
  effort: string;
  threadId: string;
}): Promise<void> {
  await db
    .insert(threadLunaEfforts)
    .values({ effort, threadId })
    .onConflictDoUpdate({
      set: { effort, updatedAt: new Date() },
      target: threadLunaEfforts.threadId,
    });
}
