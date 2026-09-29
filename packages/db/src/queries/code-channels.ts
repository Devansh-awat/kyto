import { eq } from 'drizzle-orm';
import { db } from '../client';
import { codeChannels } from '../schema';

export type CodeChannel = typeof codeChannels.$inferSelect;

export async function listCodeChannels(): Promise<CodeChannel[]> {
  return await db.select().from(codeChannels);
}

export async function addCodeChannel({
  channelId,
  enabledBy,
}: {
  channelId: string;
  enabledBy: string;
}): Promise<void> {
  await db
    .insert(codeChannels)
    .values({ channelId, enabledBy })
    .onConflictDoNothing();
}

/** True if it was a code channel. */
export async function removeCodeChannel(channelId: string): Promise<boolean> {
  const rows = await db
    .delete(codeChannels)
    .where(eq(codeChannels.channelId, channelId))
    .returning({ channelId: codeChannels.channelId });
  return rows.length > 0;
}
