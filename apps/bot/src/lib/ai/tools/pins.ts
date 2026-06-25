import { tool } from 'ai';
import type { Thread } from 'chat';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const okSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

export function pinMessageTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Pin a message to the current Slack channel so the team can find it later. Use for decisions, important links, or canonical answers.',
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the message to pin, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ messageTs }) => {
      try {
        const channelId = channelIdFromThread(thread);
        if (!channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        const result = okSchema.parse(
          await slack.webClient.apiCall('pins.add', {
            channel: channelId,
            timestamp: messageTs,
          })
        );
        if (!result.ok) {
          return { error: `Pin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: 'Pinned the message to this channel.',
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[pinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function unpinMessageTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Unpin a previously pinned message from the current Slack channel.',
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe(
          'Timestamp (ts) of the pinned message to remove, e.g. 1781599802.270109.'
        ),
    }),
    execute: async ({ messageTs }) => {
      try {
        const channelId = channelIdFromThread(thread);
        if (!channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        const result = okSchema.parse(
          await slack.webClient.apiCall('pins.remove', {
            channel: channelId,
            timestamp: messageTs,
          })
        );
        if (!result.ok) {
          return { error: `Unpin failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: 'Removed the pin from this channel.',
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[unpinMessage] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

export function bookmarkLinkTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Add a bookmark to the current Slack channel so a link is always one click away in the channel header.',
    inputSchema: z.object({
      title: z
        .string()
        .min(1)
        .max(255)
        .describe('Label shown for the bookmark.'),
      link: z.string().url().describe('The URL to bookmark.'),
      emoji: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Optional emoji shortcode, e.g. :link:.'),
    }),
    execute: async ({ title, link, emoji }) => {
      try {
        const channelId = channelIdFromThread(thread);
        if (!channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        const result = okSchema.parse(
          await slack.webClient.apiCall('bookmarks.add', {
            channel_id: channelId,
            link,
            title,
            type: 'link',
            ...(emoji && { emoji }),
          })
        );
        if (!result.ok) {
          return { error: `Bookmark failed: ${result.error}`, success: false };
        }
        return {
          success: true,
          summary: `Bookmarked "${title}" in this channel.`,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[bookmarkLink] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
