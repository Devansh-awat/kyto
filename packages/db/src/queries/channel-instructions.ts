import { desc, eq } from 'drizzle-orm';
import { db } from '../client';
import { type ChannelInstructions, channelInstructions } from '../schema';

export type { ChannelInstructions } from '../schema';

export async function getChannelInstructions(
  channelId: string
): Promise<ChannelInstructions | undefined> {
  const [row] = await db
    .select()
    .from(channelInstructions)
    .where(eq(channelInstructions.channelId, channelId))
    .limit(1);
  return row;
}

/** Every channel's instructions (the owner's App Home), newest first. */
export function listChannelInstructions(): Promise<ChannelInstructions[]> {
  return db
    .select()
    .from(channelInstructions)
    .orderBy(desc(channelInstructions.updatedAt));
}

export async function setChannelInstructions({
  channelId,
  prompt,
  setBy,
}: {
  channelId: string;
  prompt: string;
  setBy: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(channelInstructions)
    .values({ channelId, prompt, setBy, updatedAt: now })
    .onConflictDoUpdate({
      set: { prompt, setBy, updatedAt: now },
      target: channelInstructions.channelId,
    });
}

/** Returns whether there were any to delete. */
export async function deleteChannelInstructions(
  channelId: string
): Promise<boolean> {
  const rows = await db
    .delete(channelInstructions)
    .where(eq(channelInstructions.channelId, channelId))
    .returning({ channelId: channelInstructions.channelId });
  return rows.length > 0;
}

/** "Your data": everything this person last saved; returns how many. */
export async function deleteChannelInstructionsSetBy(
  userId: string
): Promise<number> {
  const rows = await db
    .delete(channelInstructions)
    .where(eq(channelInstructions.setBy, userId))
    .returning({ channelId: channelInstructions.channelId });
  return rows.length;
}
