import { eq } from 'drizzle-orm';
import { db } from '../client';
import { optIns } from '../schema';

/** Record that someone accepted the terms without joining the channel. */
export async function recordOptIn(userId: string): Promise<void> {
  await db
    .insert(optIns)
    .values({ userId })
    .onConflictDoUpdate({
      set: { acceptedAt: new Date() },
      target: optIns.userId,
    });
}

/** Everyone who opted in without joining, for the boot-time allowlist. */
export async function listOptInUserIds(): Promise<string[]> {
  const rows = await db.select({ userId: optIns.userId }).from(optIns);
  return rows.map((row) => row.userId);
}

/** Withdraw a without-joining acceptance. True if there was one. */
export async function removeOptIn(userId: string): Promise<boolean> {
  const rows = await db
    .delete(optIns)
    .where(eq(optIns.userId, userId))
    .returning({ userId: optIns.userId });
  return rows.length > 0;
}
