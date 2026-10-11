import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { db } from '../client';
import { type MessageRevision, messageRevisions } from '../schema';

export type { MessageRevision } from '../schema';

export async function recordMessageRevision(
  revision: Omit<MessageRevision, 'createdAt' | 'id'>
): Promise<void> {
  await db.insert(messageRevisions).values(revision);
}

/**
 * Every earlier version and deletion in one thread, oldest first. Without a
 * `rootTs`, the channel's top-level messages (a channel that is one
 * conversation).
 */
export async function listThreadRevisions({
  channel,
  rootTs,
  since,
}: {
  channel: string;
  rootTs?: string;
  since: Date;
}): Promise<MessageRevision[]> {
  return await db
    .select()
    .from(messageRevisions)
    .where(
      and(
        eq(messageRevisions.channel, channel),
        rootTs
          ? eq(messageRevisions.rootTs, rootTs)
          : eq(messageRevisions.rootTs, messageRevisions.messageTs),
        gt(messageRevisions.createdAt, since)
      )
    )
    .orderBy(asc(messageRevisions.id));
}

/** The owner's thread clean-up: it resets what kyto knows of the thread. */
export async function clearThreadRevisions({
  channel,
  rootTs,
}: {
  channel: string;
  rootTs: string;
}): Promise<void> {
  await db
    .delete(messageRevisions)
    .where(
      and(
        eq(messageRevisions.channel, channel),
        eq(messageRevisions.rootTs, rootTs)
      )
    );
}

/** "Your data": everything this person wrote that is kept here. */
export async function deleteRevisionsForUser(userId: string): Promise<number> {
  const removed = await db
    .delete(messageRevisions)
    .where(eq(messageRevisions.userId, userId))
    .returning({ id: messageRevisions.id });
  return removed.length;
}

export async function pruneMessageRevisions(olderThan: Date): Promise<void> {
  await db
    .delete(messageRevisions)
    .where(lt(messageRevisions.createdAt, olderThan));
}
