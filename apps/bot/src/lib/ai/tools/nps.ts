import {
  closeNpsSurvey,
  getNpsSurvey,
  listNpsResponses,
  listNpsSurveysInChannel,
} from '@repo/db/queries';
import type { NpsSurvey } from '@repo/db/schema';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { anchorCard, canAnchor, getAnchor, removeAnchor } from '@/lib/anchors';
import logger from '@/lib/logger';
import {
  DEFAULT_NPS_QUESTION,
  isNpsClosed,
  summarizeNps,
} from '@/lib/slack/nps';
import { postNpsSurvey, refreshNpsCard } from '@/lib/slack/nps-card';
import { errorMessage } from '@/lib/utils/error';
import { resolvePollTarget } from './poll-target';

const MAX_DAYS = 90;

interface NpsActor {
  authorUserId: string;
  isOwner: boolean;
  thread: Thread;
}

function channelOf(thread: Thread) {
  const [platform, channelId, threadTs] = thread.id.split(':');
  return platform === 'slack' && channelId
    ? { channelId, threadTs }
    : undefined;
}

function canManage(survey: NpsSurvey, actor: NpsActor): boolean {
  return actor.isOwner || survey.createdBy === actor.authorUserId;
}

export function npsSurveyTool(actor: NpsActor) {
  return tool({
    description:
      'Post an NPS (Net Promoter Score) survey card: one 0-10 "how likely are you to recommend…" question with a button per score. People click a score (click another to change it) and may add an anonymous comment. The card shows only the response count until it closes, then the NPS. Read results with npsResults; end it early with closeNpsSurvey.',
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(140)
        .optional()
        .describe(`The 0-10 question. Default: "${DEFAULT_NPS_QUESTION}"`),
      days: z
        .number()
        .int()
        .min(1)
        .max(MAX_DAYS)
        .default(7)
        .describe('How many days it stays open (default 7).'),
      postTo: z
        .enum(['thread', 'channel'])
        .default('thread')
        .describe(
          '"thread" (default) or "channel" for a top-level post (owner only; anyone else\'s lands in the thread).'
        ),
      anchor: z
        .boolean()
        .default(false)
        .describe(
          'Keep it at the bottom of the channel (top-level, pinned, reposted under every new message) until it closes. Channel Managers and the owner only.'
        ),
    }),
    execute: async ({ anchor, days, postTo, question }) => {
      const location = channelOf(actor.thread);
      if (!location) {
        return { error: 'Not in a Slack channel.', success: false };
      }
      if (
        anchor &&
        !(await canAnchor({
          channelId: location.channelId,
          userId: actor.authorUserId,
        }))
      ) {
        return {
          error:
            "Only this channel's Slack Channel Managers or the bot owner can anchor a survey. Offer to post it without anchoring.",
          success: false,
        };
      }
      // An anchor lives in the channel itself, so it is always top-level.
      const { redirectedToThread, threadTs } = anchor
        ? { redirectedToThread: false, threadTs: undefined }
        : resolvePollTarget(postTo, actor.isOwner, location.threadTs);
      try {
        const { messageTs, surveyId } = await postNpsSurvey({
          channelId: location.channelId,
          createdBy: actor.authorUserId,
          days,
          question: question ?? DEFAULT_NPS_QUESTION,
          threadTs,
        });
        if (anchor) {
          await anchorCard({
            channelId: location.channelId,
            createdBy: actor.authorUserId,
            kind: 'nps',
            messageTs,
            surveyId,
          });
        }
        return {
          success: true,
          surveyId,
          summary: `Posted NPS survey #${surveyId}, open for ${days} day${days === 1 ? '' : 's'}.${
            anchor
              ? ' It is anchored: pinned and kept at the bottom of the channel until it closes.'
              : ''
          }${
            redirectedToThread
              ? ' It went into this thread, not the channel: only the bot owner can have me start a top-level post. Say so if it matters.'
              : ''
          }`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[nps] create failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function npsResultsTool(actor: NpsActor) {
  return tool({
    description:
      "NPS survey results. With no surveyId, lists this channel's recent surveys. With one: the NPS (-100..100: % promoters 9-10 minus % detractors 0-6), the breakdown and average; comments (anonymous) only for the survey's creator or the bot owner.",
    inputSchema: z.object({
      surveyId: z.number().int().positive().optional(),
    }),
    execute: async ({ surveyId }) => {
      const location = channelOf(actor.thread);
      if (!location) {
        return { error: 'Not in a Slack channel.', success: false };
      }
      try {
        if (surveyId === undefined) {
          const surveys = await listNpsSurveysInChannel(location.channelId);
          return {
            success: true,
            surveys: surveys.map((survey) => ({
              closesAt: survey.closesAt.toISOString(),
              createdBy: survey.createdBy,
              id: survey.id,
              open: !isNpsClosed(survey),
              question: survey.question,
            })),
          };
        }
        const survey = await getNpsSurvey(surveyId);
        // A survey in a private channel must not be read from somewhere else.
        if (
          !survey ||
          (survey.channelId !== location.channelId && !canManage(survey, actor))
        ) {
          return { error: 'No such survey in this channel.', success: false };
        }
        const responses = await listNpsResponses(survey.id);
        return {
          ...summarizeNps(responses.map((response) => response.score)),
          closesAt: survey.closesAt.toISOString(),
          // Anonymous on purpose: the modal tells people only the creator and
          // the owner read comments, and without their name.
          comments: canManage(survey, actor)
            ? responses.flatMap((response) =>
                response.comment
                  ? [{ comment: response.comment, score: response.score }]
                  : []
              )
            : 'only the survey creator or the bot owner can read comments',
          open: !isNpsClosed(survey),
          question: survey.question,
          success: true,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[nps] results failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function closeNpsSurveyTool(actor: NpsActor) {
  return tool({
    description:
      'Close an NPS survey early (its creator or the bot owner only). The card stops taking scores and shows the final NPS.',
    inputSchema: z.object({ surveyId: z.number().int().positive() }),
    execute: async ({ surveyId }) => {
      try {
        const survey = await getNpsSurvey(surveyId);
        if (!survey) {
          return { error: 'No such survey.', success: false };
        }
        if (!canManage(survey, actor)) {
          return {
            error:
              'Only the person who started this survey or the bot owner can close it.',
            success: false,
          };
        }
        if (!(await closeNpsSurvey(surveyId))) {
          return { success: true, summary: 'It was already closed.' };
        }
        await refreshNpsCard({ ...survey, closedAt: new Date() });
        // Nothing left to collect, so it stops following the channel.
        if ((await getAnchor(survey.channelId))?.surveyId === surveyId) {
          await removeAnchor(survey.channelId);
        }
        return { success: true, summary: `Closed survey #${surveyId}.` };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[nps] close failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
