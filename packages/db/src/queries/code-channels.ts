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
  native = false,
  originThreadId,
}: {
  channelId: string;
  enabledBy: string;
  native?: boolean;
  originThreadId?: string;
}): Promise<CodeChannel> {
  const [row] = await db
    .insert(codeChannels)
    .values({ channelId, enabledBy, native, originThreadId })
    .onConflictDoUpdate({
      // Re-registering an ordinary code channel as the real thing upgrades it;
      // nothing ever downgrades one.
      set: { native },
      target: codeChannels.channelId,
      where: eq(codeChannels.native, false),
    })
    .returning();
  if (row) {
    return row;
  }
  const [existing] = await db
    .select()
    .from(codeChannels)
    .where(eq(codeChannels.channelId, channelId));
  if (!existing) {
    throw new Error(`code channel ${channelId} vanished while registering`);
  }
  return existing;
}

export async function setCodeChannelCanvasViews({
  canvasViews,
  channelId,
}: {
  canvasViews: Record<string, unknown>;
  channelId: string;
}): Promise<void> {
  await db
    .update(codeChannels)
    .set({ canvasViews })
    .where(eq(codeChannels.channelId, channelId));
}

/** True if it was a code channel. */
export async function removeCodeChannel(channelId: string): Promise<boolean> {
  const rows = await db
    .delete(codeChannels)
    .where(eq(codeChannels.channelId, channelId))
    .returning({ channelId: codeChannels.channelId });
  return rows.length > 0;
}
