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

export async function setThreadSubscription({
  respondAs,
  respondOnThreadMessages,
  threadId,
}: {
  /** Left as stored when omitted (joinThread doesn't know which kyto it is). */
  respondAs?: 'app' | 'user';
  respondOnThreadMessages: boolean;
  threadId: string;
}): Promise<void> {
  await db
    .insert(threadSubscriptions)
    .values({
      respondOnThreadMessages,
      threadId,
      ...(respondAs ? { respondAs } : {}),
    })
    .onConflictDoUpdate({
      set: { respondOnThreadMessages, ...(respondAs ? { respondAs } : {}) },
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

// Set (or clear, with null) focus mode for a thread. Setting a focus also marks
// the thread subscribed so kyto keeps following the focused users' messages
// without needing a fresh mention each time.
export async function setThreadFocus(
  threadId: string,
  focusUserIds: string[] | null
): Promise<void> {
  await db
    .insert(threadSubscriptions)
    .values({
      focusUserIds: focusUserIds ?? null,
      respondOnThreadMessages: focusUserIds !== null,
      threadId,
    })
    .onConflictDoUpdate({
      set: {
        focusUserIds: focusUserIds ?? null,
        ...(focusUserIds === null ? {} : { respondOnThreadMessages: true }),
      },
      target: threadSubscriptions.threadId,
    });
}
