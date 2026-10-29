import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  type NpsResponse,
  type NpsSurvey,
  npsResponses,
  npsSurveys,
} from '../schema';

export async function createNpsSurvey(row: {
  channelId: string;
  closesAt: Date;
  createdBy: string;
  question: string;
}): Promise<NpsSurvey> {
  const [survey] = await db.insert(npsSurveys).values(row).returning();
  if (!survey) {
    throw new Error('Inserting the NPS survey returned no row');
  }
  return survey;
}

export async function setNpsSurveyMessageTs({
  id,
  messageTs,
}: {
  id: number;
  messageTs: string;
}): Promise<void> {
  await db.update(npsSurveys).set({ messageTs }).where(eq(npsSurveys.id, id));
}

/** A survey whose card never made it to Slack is useless; drop it. */
export async function deleteNpsSurvey(id: number): Promise<void> {
  await db.delete(npsSurveys).where(eq(npsSurveys.id, id));
}

export async function getNpsSurvey(id: number): Promise<NpsSurvey | undefined> {
  const [survey] = await db
    .select()
    .from(npsSurveys)
    .where(eq(npsSurveys.id, id));
  return survey;
}

export async function listNpsSurveysInChannel(
  channelId: string
): Promise<NpsSurvey[]> {
  return await db
    .select()
    .from(npsSurveys)
    .where(eq(npsSurveys.channelId, channelId))
    .orderBy(desc(npsSurveys.createdAt))
    .limit(20);
}

/** Close early. Returns false when it was already closed by hand. */
export async function closeNpsSurvey(id: number): Promise<boolean> {
  const closed = await db
    .update(npsSurveys)
    .set({ closedAt: new Date() })
    .where(and(eq(npsSurveys.id, id), isNull(npsSurveys.closedAt)))
    .returning({ id: npsSurveys.id });
  return closed.length > 0;
}

export async function listNpsResponses(
  surveyId: number
): Promise<NpsResponse[]> {
  return await db
    .select()
    .from(npsResponses)
    .where(eq(npsResponses.surveyId, surveyId));
}

/** Record or change someone's score; an earlier comment is kept. */
export async function recordNpsScore({
  score,
  surveyId,
  userId,
}: {
  score: number;
  surveyId: number;
  userId: string;
}): Promise<void> {
  await db
    .insert(npsResponses)
    .values({ score, surveyId, userId })
    .onConflictDoUpdate({
      set: { score, updatedAt: new Date() },
      target: [npsResponses.surveyId, npsResponses.userId],
    });
}

/**
 * Attach a comment to the score this person already gave. Returns false when
 * they have no score on that survey (a comment alone is not a response).
 */
export async function recordNpsComment({
  comment,
  surveyId,
  userId,
}: {
  comment: string;
  surveyId: number;
  userId: string;
}): Promise<boolean> {
  const updated = await db
    .update(npsResponses)
    .set({ comment, updatedAt: new Date() })
    .where(
      and(eq(npsResponses.surveyId, surveyId), eq(npsResponses.userId, userId))
    )
    .returning({ surveyId: npsResponses.surveyId });
  return updated.length > 0;
}

/** "Your data": every score and comment this person gave. Returns how many. */
export async function deleteNpsResponsesForUser(
  userId: string
): Promise<number> {
  const deleted = await db
    .delete(npsResponses)
    .where(eq(npsResponses.userId, userId))
    .returning({ surveyId: npsResponses.surveyId });
  return deleted.length;
}
