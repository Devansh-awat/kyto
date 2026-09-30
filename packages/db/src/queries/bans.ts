import { asc, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../client';
import { type BannedUser, bannedUsers } from '../schema';

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
