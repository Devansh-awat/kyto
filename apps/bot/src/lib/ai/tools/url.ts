import { tool } from 'ai';
import type { Thread } from 'chat';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

const MAX_CONTENT_CHARS = 20_000;

const permalinkSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  permalink: z.string().optional(),
});

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

export function getPermalinkTool({ thread }: { thread: Thread }) {
  return tool({
    description:
      'Get a shareable Slack permalink for a message in the current channel, e.g. to reference it elsewhere.',
    inputSchema: z.object({
      messageTs: z
        .string()
        .min(1)
        .describe('Timestamp (ts) of the message, e.g. 1781599802.270109.'),
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
        const result = permalinkSchema.parse(
          await slack.webClient.apiCall('chat.getPermalink', {
            channel: channelId,
            message_ts: messageTs,
          })
        );
        if (!(result.ok && result.permalink)) {
          return {
            error: `Could not get permalink: ${result.error ?? 'unknown'}`,
            success: false,
          };
        }
        return { permalink: result.permalink, success: true };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[getPermalink] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/** Fetch a URL's text content, stripping HTML tags and truncating. Shared by
 * fetchUrlTool and the 'script'/'agent' recurring-reminder kinds. */
export async function fetchUrlText(url: string): Promise<{
  content: string;
  contentType: string;
  truncated: boolean;
}> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'kyto-slack-bot' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  // Strip tags for HTML so the model gets readable text, not markup.
  const text = contentType.includes('text/html')
    ? raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : raw;
  const truncated = text.length > MAX_CONTENT_CHARS;
  return {
    content: truncated ? text.slice(0, MAX_CONTENT_CHARS) : text,
    contentType,
    truncated,
  };
}

export function fetchUrlTool() {
  return tool({
    description:
      'Fetch the raw text content of a specific URL the user pasted or referenced. Use this instead of a web search when you already have the exact link.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL to fetch.'),
    }),
    execute: async ({ url }) => {
      try {
        const { content, contentType, truncated } = await fetchUrlText(url);
        return { content, contentType, success: true, truncated };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[fetchUrl] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
