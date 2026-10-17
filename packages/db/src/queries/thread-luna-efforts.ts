import { eq } from 'drizzle-orm';
import { db } from '../client';
import { threadLunaEfforts } from '../schema/thread-luna-efforts';

export async function getThreadLunaEffort(
  threadId: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ effort: threadLunaEfforts.effort })
    .from(threadLunaEfforts)
    .where(eq(threadLunaEfforts.threadId, threadId));
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
