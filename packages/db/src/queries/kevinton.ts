import { and, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { kevintonReviews } from '../schema';

export type KevintonReview = typeof kevintonReviews.$inferSelect;

/** A turn just ended on this thread: review it once it has been quiet a while. */
export async function noteKevintonActivity({
  dueAt,
  threadId,
}: {
  dueAt: Date;
  threadId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(kevintonReviews)
    .values({ dueAt, lastActivityAt: now, threadId })
    .onConflictDoUpdate({
      set: { dueAt, lastActivityAt: now },
      target: kevintonReviews.threadId,
    });
}

/**
 * Claim up to `limit` threads that are due and have activity kevinton has not
 * reviewed. Atomic, so two instances (a rolling deploy) never review one thread
 * twice; a claim older than `staleClaimBefore` is a review that died with its
 * instance and may be taken again.
 */
export async function claimDueKevintonReviews({
  limit,
  now,
  staleClaimBefore,
}: {
  limit: number;
  now: Date;
  staleClaimBefore: Date;
}): Promise<KevintonReview[]> {
  const due = db
    .select({ threadId: kevintonReviews.threadId })
    .from(kevintonReviews)
    .where(
      and(
        lte(kevintonReviews.dueAt, now),
        or(
          isNull(kevintonReviews.reviewedAt),
          lt(kevintonReviews.reviewedAt, kevintonReviews.lastActivityAt)
        ),
        or(
          isNull(kevintonReviews.claimedAt),
          lt(kevintonReviews.claimedAt, staleClaimBefore)
        )
      )
    )
    .orderBy(kevintonReviews.dueAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  return await db
    .update(kevintonReviews)
    .set({ claimedAt: now })
    .where(sql`${kevintonReviews.threadId} in ${due}`)
    .returning();
}

/** Done: everything up to `reviewedAt` has been looked at. */
export async function finishKevintonReview({
  reviewedAt,
  threadId,
}: {
  reviewedAt: Date;
  threadId: string;
}): Promise<void> {
  await db
    .update(kevintonReviews)
    .set({ claimedAt: null, reviewedAt })
    .where(sql`${kevintonReviews.threadId} = ${threadId}`);
}
