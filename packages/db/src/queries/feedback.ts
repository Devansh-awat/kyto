import { sql } from 'drizzle-orm';
import { db } from '../client';
import { replyFeedback } from '../schema';

/**
 * Record (or change) someone's rating of a reply. A second click on the same
 * reply replaces the rating; a comment is only overwritten when a new one is
 * given, so re-clicking 👍 after writing a comment does not erase it.
 */
export async function recordReplyFeedback({
  channelId,
  comment,
  messageTs,
  model,
  rating,
  threadId,
  userId,
}: {
  channelId: string;
  comment?: string;
  messageTs: string;
  model?: string;
  rating: 'up' | 'down';
  threadId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(replyFeedback)
    .values({
      channelId,
      comment: comment ?? null,
      messageTs,
      model: model ?? null,
      rating,
      threadId,
      userId,
    })
    .onConflictDoUpdate({
      set: {
        comment:
          comment === undefined ? sql`${replyFeedback.comment}` : comment,
        rating,
        updatedAt: new Date(),
      },
      target: [
        replyFeedback.channelId,
        replyFeedback.messageTs,
        replyFeedback.userId,
      ],
    });
}
