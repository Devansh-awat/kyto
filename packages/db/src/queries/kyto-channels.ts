import { eq } from 'drizzle-orm';
import { db } from '../client';
import { kytoChannels } from '../schema';

export async function listKytoChannelIds(
  identity: 'app' | 'user'
): Promise<string[]> {
  const rows = await db
    .select({ channelId: kytoChannels.channelId })
    .from(kytoChannels)
    .where(eq(kytoChannels.identity, identity));
  return rows.map((row) => row.channelId);
}

/** Records the channels; returns the ids that were NOT already recorded. */
export async function addKytoChannels({
  channelIds,
  identity,
}: {
  channelIds: string[];
  identity: 'app' | 'user';
}): Promise<string[]> {
  if (channelIds.length === 0) {
    return [];
  }
  const rows = await db
    .insert(kytoChannels)
    .values(channelIds.map((channelId) => ({ channelId, identity })))
    .onConflictDoNothing()
    .returning({ channelId: kytoChannels.channelId });
  return rows.map((row) => row.channelId);
}
