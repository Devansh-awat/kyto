import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  mayReadChannel,
  PRIVATE_CHANNEL_REFUSAL,
} from '@/lib/slack/channel-access';
import { toRawSlackChannelId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';

// "find the image X posted in #c 1-4 months ago" took ~30 calls and
// 123s of searchSlack, which can't see inside an image or filter by file type,
// and still missed (#109). Slack's file list can: one call per page, by
// channel, author, date range and type.
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const DEFAULT_LIMIT = 30;
const SECONDS_PER_DAY = 86_400;

const filesListSchema = z.looseObject({
  error: z.string().optional(),
  files: z
    .array(
      z.looseObject({
        created: z.number().optional(),
        id: z.string(),
        mimetype: z.string().optional(),
        name: z.string().optional(),
        permalink: z.string().optional(),
        title: z.string().optional(),
        user: z.string().optional(),
      })
    )
    .optional(),
  ok: z.boolean(),
  paging: z.looseObject({ pages: z.number().optional() }).optional(),
});
const channelInfoSchema = z.looseObject({
  channel: z
    .looseObject({
      is_im: z.boolean().optional(),
      is_mpim: z.boolean().optional(),
      is_private: z.boolean().optional(),
    })
    .optional(),
});

export function findImagesTool({
  askerUserId,
  thread,
}: {
  askerUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      "List the images posted in a Slack channel, newest first, by who posted them and when: for 'find the image/meme/screenshot X posted in #c'. Search can't see inside images, so use this instead of searchSlack loops, then download candidates with getFile and check them with viewImage and a yes/no question, in parallel. Only channels the person asking can read.",
    inputSchema: z.object({
      channelId: z
        .string()
        .optional()
        .describe('The channel id; omit for the current channel.'),
      daysAgoFrom: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Only images at most this many days old (e.g. 120 for "4 months ago").'
        ),
      daysAgoTo: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Only images at least this many days old (e.g. 30 for "a month ago").'
        ),
      limit: z.number().int().min(1).max(100).optional(),
      userId: z
        .string()
        .optional()
        .describe('Only images this user (U… id) posted.'),
    }),
    execute: async ({
      channelId: requested,
      daysAgoFrom,
      daysAgoTo,
      limit,
      userId,
    }) => {
      const [, currentChannelId] = thread.id.split(':');
      const channelId = requested
        ? toRawSlackChannelId(requested)
        : currentChannelId;
      if (!channelId) {
        return { error: 'No channel to look in.', success: false };
      }
      if (
        !(await mayReadChannel({ askerUserId, channelId, currentChannelId }))
      ) {
        return { error: PRIVATE_CHANNEL_REFUSAL, success: false };
      }
      const now = Math.floor(Date.now() / 1000);
      const wanted = limit ?? DEFAULT_LIMIT;
      const images: {
        fileId: string;
        name?: string;
        permalink?: string;
        postedAt?: string;
        userId?: string;
      }[] = [];
      // Private channels have C… ids too; the flag is what keeps this turn's
      // replayed reasoning to its asker (isPrivateObservation). Unknown counts
      // as private.
      const isPrivate = await slack.webClient
        .apiCall('conversations.info', { channel: channelId })
        .then((info) => {
          const channel = channelInfoSchema.parse(info).channel;
          return channel
            ? Boolean(channel.is_private || channel.is_im || channel.is_mpim)
            : true;
        })
        .catch(() => true);
      try {
        for (
          let page = 1;
          page <= MAX_PAGES && images.length < wanted;
          page++
        ) {
          const result = filesListSchema.parse(
            await slack.webClient.apiCall('files.list', {
              channel: channelId,
              count: PAGE_SIZE,
              page,
              types: 'images',
              ...(userId ? { user: userId } : {}),
              ...(daysAgoFrom === undefined
                ? {}
                : { ts_from: now - Math.round(daysAgoFrom * SECONDS_PER_DAY) }),
              ...(daysAgoTo === undefined
                ? {}
                : { ts_to: now - Math.round(daysAgoTo * SECONDS_PER_DAY) }),
            })
          );
          if (!result.ok) {
            return {
              error: `Slack refused the file list: ${result.error ?? 'unknown'}`,
              success: false,
            };
          }
          for (const file of result.files ?? []) {
            images.push({
              fileId: file.id,
              name: file.title ?? file.name,
              permalink: file.permalink,
              postedAt: file.created
                ? new Date(file.created * 1000).toISOString()
                : undefined,
              userId: file.user,
            });
          }
          if (page >= (result.paging?.pages ?? 1)) {
            break;
          }
        }
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[findImages] failed');
        return { error: errorMessage(error), success: false };
      }
      return {
        images: images.slice(0, wanted),
        more: images.length > wanted,
        ...(isPrivate ? { isPrivate: true } : {}),
        success: true,
        ...(images.length === 0
          ? {
              note: 'No images match. Widen the date range once, or drop the author, before saying so.',
            }
          : {}),
      };
    },
  });
}
