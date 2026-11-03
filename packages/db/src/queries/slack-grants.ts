import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../client';
import { reminders } from '../schema/reminders';
import type {
  AsUserRequest,
  SlackGrant,
  SlackGrantSecret,
} from '../schema/slack-grants';
import { asUserRequests, userSlackGrants } from '../schema/slack-grants';

export type {
  AsUserRequest,
  SlackGrant,
  SlackGrantSecret,
} from '../schema/slack-grants';

// Every column except the encrypted token. Selected explicitly so token
// material stays out of the default read path, and out of anything that logs a
// query result.
const publicColumns = {
  createdAt: userSlackGrants.createdAt,
  scopes: userSlackGrants.scopes,
  skipConfirm: userSlackGrants.skipConfirm,
  teamId: userSlackGrants.teamId,
  updatedAt: userSlackGrants.updatedAt,
  userId: userSlackGrants.userId,
};

export async function getSlackGrant(
  userId: string
): Promise<SlackGrant | null> {
  const [row] = await db
    .select(publicColumns)
    .from(userSlackGrants)
    .where(eq(userSlackGrants.userId, userId))
    .limit(1);
  return row ?? null;
}

/** The ONLY path that returns the ciphertext. Decryption happens in the bot. */
export async function getSlackGrantSecret(
  userId: string
): Promise<SlackGrantSecret | null> {
  const [row] = await db
    .select()
    .from(userSlackGrants)
    .where(eq(userSlackGrants.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function upsertSlackGrant(input: {
  encryptedToken: string;
  scopes: string;
  teamId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(userSlackGrants)
    .values(input)
    .onConflictDoUpdate({
      set: {
        encryptedToken: input.encryptedToken,
        scopes: input.scopes,
        teamId: input.teamId,
        updatedAt: new Date(),
      },
      target: userSlackGrants.userId,
    });
}

export async function deleteSlackGrant(userId: string): Promise<void> {
  await db.delete(userSlackGrants).where(eq(userSlackGrants.userId, userId));
}

export async function setSlackGrantSkipConfirm({
  skipConfirm,
  userId,
}: {
  skipConfirm: boolean;
  userId: string;
}): Promise<void> {
  await db
    .update(userSlackGrants)
    .set({ skipConfirm })
    .where(eq(userSlackGrants.userId, userId));
}

// A saved as-you request older than this can't be sent: a scheduled "good
// morning" DM going out the next afternoon is worse than not at all.
const AS_USER_REQUEST_TTL_HOURS = 24;

export async function createAsUserRequest(input: {
  id: string;
  payload: unknown;
  reminderId: string | null;
  summary: string;
  userId: string;
}): Promise<void> {
  await db.insert(asUserRequests).values(input);
}

export async function setAsUserRequestCard({
  channel,
  id,
  ts,
}: {
  channel: string;
  id: string;
  ts: string;
}): Promise<void> {
  await db
    .update(asUserRequests)
    .set({ cardChannel: channel, cardTs: ts })
    .where(eq(asUserRequests.id, id));
}

/**
 * Claim a pending request for the person it acts as. Null when it is someone
 * else's, already answered, or expired — the WHERE is the whole check, so two
 * clicks can't both win.
 */
export async function claimAsUserRequest({
  id,
  status,
  userId,
}: {
  id: string;
  status: 'cancelled' | 'sending';
  userId: string;
}): Promise<AsUserRequest | null> {
  const [row] = await db
    .update(asUserRequests)
    .set({ decidedAt: new Date(), status })
    .where(
      and(
        eq(asUserRequests.id, id),
        eq(asUserRequests.userId, userId),
        eq(asUserRequests.status, 'pending'),
        gt(
          asUserRequests.createdAt,
          sql`now() - make_interval(hours => ${AS_USER_REQUEST_TTL_HOURS})`
        )
      )
    )
    .returning();
  return row ?? null;
}

export async function finishAsUserRequest({
  id,
  ok,
}: {
  id: string;
  ok: boolean;
}): Promise<void> {
  await db
    .update(asUserRequests)
    .set({ status: ok ? 'sent' : 'failed' })
    .where(eq(asUserRequests.id, id));
}

export async function deleteUserAsUserRequests(userId: string): Promise<void> {
  await db.delete(asUserRequests).where(eq(asUserRequests.userId, userId));
}

/** Only the reminder's CREATOR can lend it their account. */
export async function setReminderAsUserApproval({
  approval,
  id,
  userId,
}: {
  approval: 'always' | 'ask' | 'next';
  id: string;
  userId: string;
}): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ asUserApproval: approval })
    .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
    .returning({ id: reminders.id });
  return rows.length > 0;
}

/** Spend a 'next run only' approval. True when this call spent it. */
export async function consumeNextRunAsUserApproval(
  id: string
): Promise<boolean> {
  const rows = await db
    .update(reminders)
    .set({ asUserApproval: 'ask' })
    .where(and(eq(reminders.id, id), eq(reminders.asUserApproval, 'next')))
    .returning({ id: reminders.id });
  return rows.length > 0;
}
