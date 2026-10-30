import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { type ChannelAnchor, channelAnchors } from '../schema';

export async function listChannelAnchors(): Promise<ChannelAnchor[]> {
  return await db.select().from(channelAnchors);
}

/** Anchor a card, replacing whatever the channel had anchored. */
export async function setChannelAnchor(row: {
  channelId: string;
  createdBy: string;
  kind: 'poll' | 'nps';
  messageTs: string;
  surveyId: number | null;
}): Promise<void> {
  await db
    .insert(channelAnchors)
    .values(row)
    .onConflictDoUpdate({
      set: { ...row, createdAt: new Date() },
      target: channelAnchors.channelId,
    });
}

/**
 * Point the anchor at its reposted card. Conditional on the old ts, so a
 * repost racing a replacement or a removal can't resurrect the old anchor.
 */
export async function moveChannelAnchor({
  channelId,
  fromTs,
  toTs,
}: {
  channelId: string;
  fromTs: string;
  toTs: string;
}): Promise<boolean> {
  const moved = await db
    .update(channelAnchors)
    .set({ messageTs: toTs })
    .where(
      and(
        eq(channelAnchors.channelId, channelId),
        eq(channelAnchors.messageTs, fromTs)
      )
    )
    .returning({ channelId: channelAnchors.channelId });
  return moved.length > 0;
}

export async function deleteChannelAnchor(channelId: string): Promise<void> {
  await db
    .delete(channelAnchors)
    .where(eq(channelAnchors.channelId, channelId));
}
