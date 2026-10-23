import { eq } from 'drizzle-orm';
import { db } from '../client';
import { emojiSubmissions } from '../schema';

/** Record who asked for an emoji kyto added directly, so they can remove it. */
export async function recordEmojiSubmission({
  name,
  requestedBy,
}: {
  name: string;
  requestedBy: string;
}): Promise<void> {
  await db
    .insert(emojiSubmissions)
    .values({ name, requestedBy })
    .onConflictDoUpdate({
      set: { createdAt: new Date(), requestedBy },
      target: emojiSubmissions.name,
    });
}

/** The user who requested this emoji, or null if kyto has no record of it. */
export async function getEmojiSubmitter(name: string): Promise<string | null> {
  const [row] = await db
    .select({ requestedBy: emojiSubmissions.requestedBy })
    .from(emojiSubmissions)
    .where(eq(emojiSubmissions.name, name))
    .limit(1);
  return row?.requestedBy ?? null;
}

/** Drop the record when an emoji is removed. */
export async function clearEmojiSubmission(name: string): Promise<void> {
  await db.delete(emojiSubmissions).where(eq(emojiSubmissions.name, name));
}
