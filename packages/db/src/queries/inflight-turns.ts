import { and, eq, gt, gte, lt, or, sql } from 'drizzle-orm';
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
      resumes: 0,
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
        // A resumption keeps its count; a new turn in the thread starts over.
        resumes: resumed ? sql`${inflightTurns.resumes}` : 0,
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

function orphaned({
  instanceId,
  staleBefore,
}: {
  instanceId: string;
  staleBefore: Date;
}) {
  return and(
    eq(inflightTurns.status, 'running'),
    lt(inflightTurns.heartbeatAt, staleBefore),
    sql`${inflightTurns.instanceId} <> ${instanceId}`
  );
}

/**
 * Take ownership of turns another instance left behind: interrupted by a
 * shutdown (fewer than `maxRestartResumes` times so far), or still `running`
 * with a stale heartbeat (a crash, never resumed before). Atomic — two
 * instances polling at once can never both get the same row. Only turns last
 * alive after `aliveAfter` — measured from the heartbeat, not the start: a turn
 * that had run 39 minutes when a deploy cut it was dropped without a word
 * (2026-10-03) because it STARTED outside the window.
 */
export async function claimOrphanedTurns({
  instanceId,
  maxRestartResumes,
  staleBefore,
  aliveAfter,
}: {
  instanceId: string;
  maxRestartResumes: number;
  staleBefore: Date;
  aliveAfter: Date;
}): Promise<InflightTurn[]> {
  return await db
    .update(inflightTurns)
    .set({
      instanceId,
      resumed: true,
      resumes: sql`${inflightTurns.resumes} + 1`,
      status: 'resuming',
    })
    .where(
      and(
        gt(inflightTurns.heartbeatAt, aliveAfter),
        or(
          and(
            eq(inflightTurns.status, 'interrupted'),
            lt(inflightTurns.resumes, maxRestartResumes)
          ),
          and(
            orphaned({ instanceId, staleBefore }),
            eq(inflightTurns.resumes, 0)
          )
        )
      )
    )
    .returning();
}

/**
 * Remove the orphaned turns that will NOT be resumed (out of resumes), so the
 * caller can say so in the thread instead of the turn just stopping.
 */
export async function claimAbandonedTurns({
  instanceId,
  maxRestartResumes,
  staleBefore,
  aliveAfter,
}: {
  instanceId: string;
  maxRestartResumes: number;
  staleBefore: Date;
  aliveAfter: Date;
}): Promise<InflightTurn[]> {
  return await db
    .delete(inflightTurns)
    .where(
      and(
        gt(inflightTurns.heartbeatAt, aliveAfter),
        or(
          and(
            eq(inflightTurns.status, 'interrupted'),
            gte(inflightTurns.resumes, maxRestartResumes)
          ),
          and(
            orphaned({ instanceId, staleBefore }),
            gt(inflightTurns.resumes, 0)
          )
        )
      )
    )
    .returning();
}

/** Drop rows too old to resume, so the table cannot grow without bound. */
export async function pruneInflightTurns(aliveBefore: Date): Promise<void> {
  await db
    .delete(inflightTurns)
    .where(lt(inflightTurns.heartbeatAt, aliveBefore));
}
