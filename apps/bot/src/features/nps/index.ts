import {
  getNpsSurvey,
  recordNpsComment,
  recordNpsScore,
} from '@repo/db/queries';
import { z } from 'zod';
import { mrkdwn, plainText } from '@/harness/views';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  isNpsClosed,
  NPS_COMMENT_BLOCK,
  NPS_COMMENT_CALLBACK,
  NPS_SCORE_ACTIONS,
  scoreFromActionId,
} from '@/lib/slack/nps';
import { refreshNpsCard } from '@/lib/slack/nps-card';
import { toLogError } from '@/lib/utils/error';

// A score button on an `npsSurvey` card. The score is saved the moment it is
// clicked; the modal that follows only adds an optional comment to the same
// row. Comments go to a modal rather than a thread reply because a reply in a
// thread kyto follows is a message TO kyto, and would start a turn.

const MAX_COMMENT_CHARS = 2000;

// Round-tripped through Slack in private_metadata, so parsed, not trusted. It
// only names the survey; the row is keyed by the SUBMITTER's own id.
const metadataSchema = z.object({ surveyId: z.number().int().positive() });

bot.onAction(NPS_SCORE_ACTIONS, async (event) => {
  const score = scoreFromActionId(event.actionId);
  const surveyId = Number(event.value);
  if (score === undefined || !Number.isInteger(surveyId)) {
    return;
  }
  const survey = await getNpsSurvey(surveyId).catch(() => undefined);
  if (!survey) {
    return;
  }
  const userId = event.user.userId;

  if (isNpsClosed(survey)) {
    await event.thread
      ?.postEphemeral(event.user, 'This survey has closed.')
      .catch(() => undefined);
    // Nothing closes a survey when its date passes; the first click after does.
    await refreshNpsCard(survey);
    return;
  }

  try {
    await recordNpsScore({ score, surveyId, userId });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), surveyId, userId },
      '[nps] could not save a score'
    );
    await event.thread
      ?.postEphemeral(event.user, 'Could not save your score. Try again.')
      .catch(() => undefined);
    return;
  }
  await refreshNpsCard(survey);

  if (!event.triggerId) {
    return;
  }
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            text: mrkdwn(
              `thanks! recorded your score: *${score}*. want to say why? only the survey's creator and kyto's owner can read it, without your name.`
            ),
            type: 'section',
          },
          {
            block_id: NPS_COMMENT_BLOCK,
            element: {
              action_id: 'comment',
              max_length: MAX_COMMENT_CHARS,
              multiline: true,
              type: 'plain_text_input',
            },
            label: plainText('Comment (optional)'),
            optional: true,
            type: 'input',
          },
        ],
        callback_id: NPS_COMMENT_CALLBACK,
        close: plainText('Skip'),
        private_metadata: JSON.stringify({ surveyId }),
        submit: plainText('Send'),
        title: plainText('Survey'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), surveyId, userId },
        '[nps] could not open the comment box'
      );
    });
});

bot.onModalSubmit(NPS_COMMENT_CALLBACK, async (event) => {
  const parsed = metadataSchema.safeParse(
    (() => {
      try {
        return JSON.parse(event.privateMetadata ?? '');
      } catch {
        return null;
      }
    })()
  );
  const comment = event.values[NPS_COMMENT_BLOCK]?.trim();
  if (!(parsed.success && comment)) {
    return { action: 'clear' };
  }
  const { surveyId } = parsed.data;
  const survey = await getNpsSurvey(surveyId).catch(() => undefined);
  if (!survey || isNpsClosed(survey)) {
    return {
      action: 'errors',
      errors: { [NPS_COMMENT_BLOCK]: 'This survey has closed.' },
    };
  }
  const userId = event.user.userId;
  try {
    await recordNpsComment({ comment, surveyId, userId });
  } catch (error) {
    logger.warn(
      { ...toLogError(error), surveyId, userId },
      '[nps] could not save a comment'
    );
    return {
      action: 'errors',
      errors: { [NPS_COMMENT_BLOCK]: 'Could not save that. Try again.' },
    };
  }
  return { action: 'clear' };
});
