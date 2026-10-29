import { listNpsResponses } from '@repo/db/queries';
import type { NpsSurvey } from '@repo/db/schema';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { buildNpsBlocks } from './nps';

/** Re-render a survey card from the database (a score, a close). */
export async function refreshNpsCard(survey: NpsSurvey): Promise<void> {
  if (!survey.messageTs) {
    return;
  }
  const responses = await listNpsResponses(survey.id);
  await slack.webClient
    .apiCall('chat.update', {
      blocks: buildNpsBlocks({ responses, survey }),
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
