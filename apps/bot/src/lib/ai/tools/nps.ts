import {
  closeNpsSurvey,
  createNpsSurvey,
  deleteNpsSurvey,
  getNpsSurvey,
  listNpsResponses,
  listNpsSurveysInChannel,
  setNpsSurveyMessageTs,
} from '@repo/db/queries';
import type { NpsSurvey } from '@repo/db/schema';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  buildNpsBlocks,
  DEFAULT_NPS_QUESTION,
  isNpsClosed,
  summarizeNps,
} from '@/lib/slack/nps';
import { refreshNpsCard } from '@/lib/slack/nps-card';
import { errorMessage } from '@/lib/utils/error';
import { resolvePollTarget } from './poll-target';

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;

const postMessageSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

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
    }),
    execute: async ({ days, postTo, question }) => {
      const location = channelOf(actor.thread);
      if (!location) {
        return { error: 'Not in a Slack channel.', success: false };
      }
      const { redirectedToThread, threadTs } = resolvePollTarget(
        postTo,
        actor.isOwner,
        location.threadTs
      );
      try {
        const survey = await createNpsSurvey({
          channelId: location.channelId,
          closesAt: new Date(Date.now() + days * DAY_MS),
          createdBy: actor.authorUserId,
          question: question ?? DEFAULT_NPS_QUESTION,
        });
        const posted = postMessageSchema.parse(
          await slack.webClient.apiCall('chat.postMessage', {
            blocks: buildNpsBlocks({ responses: [], survey }),
            channel: location.channelId,
            text: `Survey: ${survey.question}`,
            ...(threadTs && { thread_ts: threadTs }),
          })
        );
        if (!(posted.ok && posted.ts)) {
          await deleteNpsSurvey(survey.id);
          return {
            error: `Failed to post the survey: ${posted.error ?? 'unknown'}`,
            success: false,
          };
        }
        await setNpsSurveyMessageTs({ id: survey.id, messageTs: posted.ts });
        return {
          success: true,
          surveyId: survey.id,
          summary: `Posted NPS survey #${survey.id}, open for ${days} day${days === 1 ? '' : 's'}.${
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
        return { success: true, summary: `Closed survey #${surveyId}.` };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[nps] close failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
