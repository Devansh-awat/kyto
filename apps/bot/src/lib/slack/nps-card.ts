import {
  createNpsSurvey,
  deleteNpsSurvey,
  listNpsResponses,
  setNpsSurveyMessageTs,
} from '@repo/db/queries';
import type { NpsSurvey } from '@repo/db/schema';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { buildNpsBlocks } from './nps';
import { askerName, postSlackMessage } from './poll';

/** Re-render a survey card from the database (a score, a close). */
export async function refreshNpsCard(survey: NpsSurvey): Promise<void> {
  if (!survey.messageTs) {
    return;
  }
  const responses = await listNpsResponses(survey.id);
  await slack.webClient
    .apiCall('chat.update', {
      blocks: buildNpsBlocks({
        askedBy: await askerName(survey.createdBy),
        responses,
        survey,
      }),
      channel: survey.channelId,
      text: `Survey: ${survey.question}`,
      ts: survey.messageTs,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), surveyId: survey.id },
        '[nps] could not update the survey card'
      );
    });
}

const DAY_MS = 86_400_000;

/** Create a survey and post its card; a card Slack refuses leaves no row. */
export async function postNpsSurvey({
  channelId,
  createdBy,
  days,
  question,
  threadTs,
}: {
  channelId: string;
  createdBy: string;
  days: number;
  question: string;
  threadTs?: string;
}): Promise<{ messageTs: string; surveyId: number }> {
  const survey = await createNpsSurvey({
    channelId,
    closesAt: new Date(Date.now() + days * DAY_MS),
    createdBy,
    question,
  });
  try {
    const messageTs = await postSlackMessage({
      blocks: buildNpsBlocks({
        askedBy: await askerName(createdBy),
        responses: [],
        survey,
      }),
      channel: channelId,
      text: `Survey: ${survey.question}`,
      ...(threadTs && { thread_ts: threadTs }),
    });
    await setNpsSurveyMessageTs({ id: survey.id, messageTs });
    return { messageTs, surveyId: survey.id };
  } catch (error) {
    await deleteNpsSurvey(survey.id);
    throw error;
  }
}
