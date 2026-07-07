import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  type ThreadSubscription,
  threadSubscriptions,
} from '../schema/threads';

export async function getThreadSubscription(
  threadId: string
): Promise<ThreadSubscription | null> {
  const rows = await db
    .select()
    .from(threadSubscriptions)
    .where(eq(threadSubscriptions.threadId, threadId))
    .limit(1);
  return rows[0] ?? null;
}

export async function setThreadSubscription(
  threadId: string,
  respondOnThreadMessages: boolean
): Promise<void> {
  await db
    .insert(threadSubscriptions)
    .values({ respondOnThreadMessages, threadId })
    .onConflictDoUpdate({
      set: { respondOnThreadMessages },
      target: threadSubscriptions.threadId,
    });
}

export async function deleteThreadSubscription(
  threadId: string
): Promise<void> {
  await db
    .delete(threadSubscriptions)
    .where(eq(threadSubscriptions.threadId, threadId));
}
