import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { anchorCard, canAnchor } from '@/lib/anchors';
import logger from '@/lib/logger';
import {
  askerName,
  buildPollBlocks,
  buildPollMetadata,
  postSlackMessage,
} from '@/lib/slack/poll';
import { errorMessage } from '@/lib/utils/error';
import { resolvePollTarget } from './poll-target';

export function pollTool({
  authorUserId,
  isOwner,
  thread,
}: {
  authorUserId: string;
  isOwner: boolean;
  thread: Thread;
}) {
  return tool({
    description:
      'Post an interactive poll card to the current thread, or to the top level of the current channel with postTo "channel" (owner only; anyone else\'s "channel" lands in the thread instead). Members vote by clicking a button under their choice (click again to undo); the card shows live tallies with bars. No reactions involved.',
    inputSchema: z.object({
      question: z.string().min(1).max(300).describe('The poll question.'),
      options: z
        .array(z.string().min(1).max(150))
        .min(2)
        .max(10)
        .describe('Between 2 and 10 answer options.'),
      postTo: z
        .enum(['thread', 'channel'])
        .default('thread')
        .describe(
          'Where the poll card goes: "thread" (default) inside the current thread, or "channel" as a new top-level message in the current channel. Use it when asked to put the poll in the channel itself rather than the thread.'
        ),
      anchor: z
        .boolean()
        .default(false)
        .describe(
          'Keep it at the bottom of the channel (top-level, pinned, reposted under every new message). Channel Managers and the owner only.'
        ),
    }),
    execute: async ({ anchor, options, postTo, question }) => {
      try {
        const [platform, channelId, threadTs] = thread.id.split(':');
        if (platform !== 'slack' || !channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        if (anchor && !(await canAnchor({ channelId, userId: authorUserId }))) {
          return {
            error:
              "Only this channel's Slack Channel Managers or the bot owner can anchor a poll. Offer to post it without anchoring.",
            success: false,
          };
        }

        // An anchor lives in the channel itself, so it is always top-level.
        const { redirectedToThread, threadTs: targetThreadTs } = anchor
          ? { redirectedToThread: false, threadTs: undefined }
          : resolvePollTarget(postTo, isOwner, threadTs);

        const state = {
          askedBy: await askerName(authorUserId),
          options,
          question,
          votes: {},
        };
        const messageTs = await postSlackMessage({
          blocks: buildPollBlocks(state),
          channel: channelId,
          metadata: buildPollMetadata(state),
          text: `Poll: ${question}`,
          ...(targetThreadTs && { thread_ts: targetThreadTs }),
        });
        if (anchor) {
          await anchorCard({
            channelId,
            createdBy: authorUserId,
            kind: 'poll',
            messageTs,
            surveyId: null,
          });
        }

        return {
          optionCount: options.length,
          success: true,
          summary: redirectedToThread
            ? 'Posted the poll as a reply in this thread rather than as a new message in the channel. Only the bot owner can have me start a top-level post. Say so if it matters; do not try another route.'
            : `Posted an interactive poll with ${options.length} options.${anchor ? ' It is anchored: pinned and kept at the bottom of the channel until someone runs /kyto anchor off.' : ''}`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[poll] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
