import { asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { type BannedUser, bannedUsers, codingWarnings } from '../schema';

export type { BannedUser } from '../schema';

/**
 * The live ban for this user, or null. A row whose `expiresAt` has passed is
 * not live — the ban lifts itself, so nothing has to run on a timer.
 */
export async function getBan(userId: string): Promise<BannedUser | null> {
  const [row] = await db
    .select()
    .from(bannedUsers)
    .where(eq(bannedUsers.userId, userId))
    .limit(1);
  if (!row) {
    return null;
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return row;
}

/** Ban, or replace an existing ban with new terms. */
export async function createBan({
  bannedBy,
  expiresAt,
  reason,
  userId,
}: {
  bannedBy: string;
  expiresAt: Date | null;
  reason: string;
  userId: string;
}): Promise<BannedUser | null> {
  const [row] = await db
    .insert(bannedUsers)
    .values({ bannedBy, expiresAt, reason, userId })
    .onConflictDoUpdate({
      set: { bannedBy, createdAt: new Date(), expiresAt, reason },
      target: bannedUsers.userId,
    })
    .returning();
  return row ?? null;
}

/** Lift a ban. False when there was nothing to lift. */
export async function removeBan(userId: string): Promise<boolean> {
  const rows = await db
    .delete(bannedUsers)
    .where(eq(bannedUsers.userId, userId))
    .returning();
  return rows.length > 0;
}

/** Every ban still in force, soonest to expire first. */
export async function listBans(): Promise<BannedUser[]> {
  return await db
    .select()
    .from(bannedUsers)
    .where(
      or(isNull(bannedUsers.expiresAt), gt(bannedUsers.expiresAt, new Date()))
    )
    .orderBy(asc(bannedUsers.expiresAt));
}

/**
 * Record an anti-coding catch and return how many catches in a row this is.
 * A catch within `windowMs` of the previous one extends the run; a longer gap
 * starts over at 1. One statement, so two catches at once can't both read the
 * same count and both be let off with a warning.
 */
export async function recordCodingWarning({
  userId,
  windowMs,
}: {
  userId: string;
  windowMs: number;
}): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const [row] = await db
    .insert(codingWarnings)
    .values({ count: 1, userId, warnedAt: now })
    .onConflictDoUpdate({
      set: {
        count: sql`case when ${codingWarnings.warnedAt} > ${cutoff.toISOString()}::timestamptz then ${codingWarnings.count} + 1 else 1 end`,
        warnedAt: now,
      },
      target: codingWarnings.userId,
    })
    .returning({ count: codingWarnings.count });
  return row?.count ?? 1;
}
