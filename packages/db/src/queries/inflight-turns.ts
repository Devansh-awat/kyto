import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { type InflightTurn, inflightTurns } from '../schema';

export type { InflightTurn } from '../schema';

/** A turn started (or a resumed one restarted) on this instance. */
export async function startInflightTurn({
  asUserAccount,
  instanceId,
  messageId,
  resumed,
  threadId,
  userId,
}: {
  asUserAccount: boolean;
  instanceId: string;
  messageId: string;
  resumed: boolean;
  threadId: string;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(inflightTurns)
    .values({
      asUserAccount,
      heartbeatAt: now,
      instanceId,
      messageId,
      resumed,
      startedAt: now,
      status: 'running',
      threadId,
      userId,
    })
    .onConflictDoUpdate({
      set: {
        asUserAccount,
        heartbeatAt: now,
        instanceId,
        messageId,
        resumed,
        startedAt: now,
        status: 'running',
        userId,
      },
      target: inflightTurns.threadId,
    });
}

export async function heartbeatInflightTurn({
  instanceId,
  threadId,
}: {
  instanceId: string;
  threadId: string;
}): Promise<void> {
  await db
    .update(inflightTurns)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        eq(inflightTurns.threadId, threadId),
        eq(inflightTurns.instanceId, instanceId)
      )
    );
}

/** The turn ended (answered, failed, stopped): nothing to resume. */
export async function finishInflightTurn({
  instanceId,
  threadId,
}: {
  instanceId: string;
  threadId: string;
}): Promise<void> {
  await db
    .delete(inflightTurns)
    .where(
      and(
        eq(inflightTurns.threadId, threadId),
        eq(inflightTurns.instanceId, instanceId)
      )
    );
}

/** This instance is shutting down: everything it was running is resumable. */
export async function markInstanceInterrupted(
  instanceId: string
): Promise<void> {
  await db
    .update(inflightTurns)
    .set({ status: 'interrupted' })
    .where(
      and(
        eq(inflightTurns.instanceId, instanceId),
        eq(inflightTurns.status, 'running')
      )
    );
}

/**
 * Take ownership of turns another instance left behind: interrupted by a
 * shutdown, or still `running` with a stale heartbeat (a crash). Atomic — two
 * instances polling at once can never both get the same row. Only turns started
 * after `startedAfter`, and never one that was already resumed once.
 */
export async function claimOrphanedTurns({
  instanceId,
  staleBefore,
  startedAfter,
}: {
  instanceId: string;
  staleBefore: Date;
  startedAfter: Date;
}): Promise<InflightTurn[]> {
  return await db
    .update(inflightTurns)
    .set({ instanceId, resumed: true, status: 'resuming' })
    .where(
      and(
        eq(inflightTurns.resumed, false),
        gt(inflightTurns.startedAt, startedAfter),
        or(
          eq(inflightTurns.status, 'interrupted'),
          and(
            eq(inflightTurns.status, 'running'),
            lt(inflightTurns.heartbeatAt, staleBefore),
            sql`${inflightTurns.instanceId} <> ${instanceId}`
          )
        )
      )
    )
    .returning();
}

/** Drop rows too old to resume, so the table cannot grow without bound. */
export async function pruneInflightTurns(startedBefore: Date): Promise<void> {
  await db
    .delete(inflightTurns)
    .where(lt(inflightTurns.startedAt, startedBefore));
}
