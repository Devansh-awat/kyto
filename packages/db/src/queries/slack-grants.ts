import { eq } from 'drizzle-orm';
import { db } from '../client';
import type { SlackGrant, SlackGrantSecret } from '../schema/slack-grants';
import { userSlackGrants } from '../schema/slack-grants';

export type { SlackGrant, SlackGrantSecret } from '../schema/slack-grants';

// Every column except the encrypted token. Selected explicitly so token
// material stays out of the default read path, and out of anything that logs a
// query result.
const publicColumns = {
  createdAt: userSlackGrants.createdAt,
  scopes: userSlackGrants.scopes,
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
