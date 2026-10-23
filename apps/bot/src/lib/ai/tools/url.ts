import nodePath from 'node:path';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { publicFetch } from '@/lib/public-url';
import {
  mayReadChannel,
  PRIVATE_CHANNEL_REFUSAL,
} from '@/lib/slack/channel-access';
import { toRawSlackChannelId } from '@/lib/slack/ids';
import { errorMessage } from '@/lib/utils/error';

// One part of a page. A longer page is read in parts via `offset`: a hard cut
// with no way past it had kyto "summarising" legal pages from their first 20k
// characters (Microsoft's services agreement is ~124k).
const MAX_CONTENT_CHARS = 20_000;
// Read at most this much of the body: an unbounded read of a multi-gigabyte URL
// would OOM the bot.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// A bot wall (Cloudflare 401/403) or a JavaScript shell with almost no text is
// refetched through Jina's reader, which renders the page: OpenAI's policy pages
// came back as a 403 or a ~10 KB script shell to every route but that one
// (issue #70). Only the URL goes to Jina, never anything from Slack.
const READER_PREFIX = 'https://r.jina.ai/';
const SHELL_MAX_TEXT_CHARS = 2000;
// A wiki or CMS answers a missing page with 200 and a "doesn't exist" body;
// kyto read DokuWiki's "This topic does not exist yet" as the page (#94). Only
// a SHORT page saying so counts — a long one is a real page quoting the words.
const SOFT_404_MAX_CHARS = 3000;
const SOFT_404 =
  /\b(?:this (?:topic|page) does not exist yet|page not found|404 not found|the page you requested (?:could not be found|does not exist)|there is currently no text in this page)\b/i;
// The start of a saved page shown inline, so the model can tell at once
// whether it got the right document.
const SAVED_PREVIEW_CHARS = 1500;
const HTML_ENTITIES: Record<string, string> = {
  '&#39;': "'",
  '&amp;': '&',
  '&gt;': '>',
  '&lt;': '<',
  '&nbsp;': ' ',
  '&quot;': '"',
};

// Slack workspace/message/file URLs (e.g. foo.slack.com, files.slack.com) —
// these require an authenticated session, so fetchUrl can't read them.
function isSlackLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'slack.com' || host.endsWith('.slack.com');
  } catch {
    return false;
  }
}

const permalinkSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  permalink: z.string().optional(),
});

function channelIdFromThread(thread: Thread): string | undefined {
  const [platform, channelId] = thread.id.split(':');
  return platform === 'slack' ? channelId : undefined;
}

export function getPermalinkTool({
  askerUserId,
  thread,
}: {
  askerUserId: string;
  thread: Thread;
}) {
  return tool({
    description:
      "Get a shareable Slack permalink for a message, e.g. to reference it elsewhere: in this channel by default, or in any channel the asker can read. If it fails, don't build a link by hand; say you couldn't get one.",
    inputSchema: z.object({
      channelId: z
        .string()
        .optional()
        .describe(
          "The message's channel id; omit for the current channel. Needed for a message found elsewhere (e.g. by searchSlack)."
        ),
      messageTs: z
        .string()
        .min(1)
        .describe('Timestamp (ts) of the message, e.g. 1781599802.270109.'),
    }),
    execute: async ({ channelId: requested, messageTs }) => {
      try {
        const currentChannelId = channelIdFromThread(thread);
        const channelId = requested
          ? toRawSlackChannelId(requested)
          : currentChannelId;
        if (!channelId) {
          return {
            error: 'Could not resolve a Slack channel for this thread.',
            success: false,
          };
        }
        // A permalink confirms a message exists; elsewhere that is a read of
        // another conversation, so it carries the same membership gate.
        if (
          !(await mayReadChannel({ askerUserId, channelId, currentChannelId }))
        ) {
          return { error: PRIVATE_CHANNEL_REFUSAL, success: false };
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

/**
 * Fetch a URL as readable text (HTML is stripped to its text content). Throws
 * on a Slack link or a non-OK response. Shared by the `fetchUrl` tool and by
 * 'script' reminders, which post a URL's content on a schedule.
 */
export async function fetchUrlText({
  offset = 0,
  url,
  whole = false,
}: {
  offset?: number;
  url: string;
  /** The whole text, not a part (it is going to a file, not the context). */
  whole?: boolean;
}): Promise<{
  content: string;
  contentType: string;
  nextOffset?: number;
  totalChars: number;
  truncated: boolean;
  via: 'direct' | 'r.jina.ai';
}> {
  // Slack message/file links aren't publicly fetchable (they 302 to a login
  // wall), so callers get pointed at the Slack read tools instead of markup.
  if (isSlackLink(url)) {
    throw new Error(
      "That's a Slack link, which isn't publicly fetchable. Use Slack tools instead: readConversationHistory with the whole link as `permalink` for a message/thread, or getFile for a file link."
    );
  }
  // publicFetch, not fetch: this runs on kyto's host, so a URL (or a redirect)
  // pointing at the metadata endpoint or another container would be
  // read and printed back.
  const response = await publicFetch(url, {
    headers: { 'User-Agent': 'kyto-slack-bot' },
    signal: AbortSignal.timeout(15_000),
  });
  const botWall = response.status === 401 || response.status === 403;
  if (!(response.ok || botWall)) {
    await response.body?.cancel();
    throw new Error(`Fetch failed: ${response.status}`);
  }
  let contentType = response.headers.get('content-type') ?? '';
  let text = '';
  // A PDF comes back as binary bytes, not text: decoding it as a string gave
  // the model `%PDF-1.7` plus mojibake and, when a tool result holding that
  // binary reached the restart checkpoint, broke the Postgres write (#143/#144).
  // Pull the real text out instead.
  if (response.ok && /application\/pdf|application\/x-pdf/i.test(contentType)) {
    const buffer = await readCappedBytes(response);
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const extracted = await extractText(pdf, { mergePages: true });
      text = (
        Array.isArray(extracted.text)
          ? extracted.text.join('\n')
          : extracted.text
      ).trim();
      contentType = 'text/plain';
    } catch (error) {
      throw new Error(
        `That URL is a PDF kyto couldn't read as text (${errorMessage(error)}). Download it into the sandbox and run pdftotext instead.`
      );
    }
    if (!text) {
      throw new Error(
        "That PDF has no extractable text (it's probably scanned images). Download it into the sandbox and OCR it if you need the content."
      );
    }
  } else if (response.ok) {
    const raw = await readCapped(response);
    // Strip tags for HTML so the reader gets readable text, not markup. Block
    // ends become line breaks (one 124k-char line could not be grepped or
    // read in parts), and site chrome goes: a legal page's nav menu was read
    // as its first clause (#85).
    text = contentType.includes('text/html')
      ? raw
          .replace(
            /<(script|style|noscript|svg|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi,
            ''
          )
          .replace(
            /<br\s*\/?>|<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi,
            '\n'
          )
          .replace(/<[^>]+>/g, ' ')
          .replace(
            /&(?:#39|amp|gt|lt|nbsp|quot);/g,
            (entity) => HTML_ENTITIES[entity] ?? entity
          )
          .replace(/[ \t\r\f\v]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : raw;
  } else {
    await response.body?.cancel();
  }
  let via: 'direct' | 'r.jina.ai' = 'direct';
  const shell =
    contentType.includes('text/html') && text.length < SHELL_MAX_TEXT_CHARS;
  if (botWall || shell) {
    const reader = await publicFetch(`${READER_PREFIX}${url}`, {
      headers: { 'User-Agent': 'kyto-slack-bot' },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    let readerText = '';
    if (reader?.ok) {
      readerText = (await readCapped(reader)).trim();
    } else {
      await reader?.body?.cancel();
    }
    if (readerText.length > text.length) {
      text = readerText;
      contentType = 'text/markdown';
      via = 'r.jina.ai';
    } else if (botWall) {
      // 401/403 on a public page is a bot wall (Cloudflare, a "security
      // verification" page), not a permissions problem: retrying with curl or
      // other headers just burns steps.
      throw new Error(
        `Fetch failed: ${response.status}: the site blocks automated fetches, through a reader too; a real browser may get through, or ask the user to paste or attach the page`
      );
    }
  }
  if (text.length < SOFT_404_MAX_CHARS && SOFT_404.test(text)) {
    throw new Error(
      `Fetch failed: the page does not exist (the site answered ${response.status}, but the page says it isn't there). Don't report its text as the page.`
    );
  }
  const end = whole ? text.length : offset + MAX_CONTENT_CHARS;
  const truncated = text.length > end;
  return {
    content: text.slice(offset, end),
    contentType,
    ...(truncated ? { nextOffset: end } : {}),
    totalChars: text.length,
    truncated,
    via,
  };
}

async function readCappedBytes(response: Response): Promise<ArrayBuffer> {
  if (!response.body) {
    return new ArrayBuffer(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
      if (bytes >= MAX_BODY_BYTES) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BODY_BYTES) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

export function fetchUrlTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      "Fetch the text content of a specific URL the user pasted or referenced. Use this instead of a web search when you already have the exact link. A bot-walled or JavaScript-only page is read through a rendering reader automatically (`via` says which route worked). A page longer than 20,000 characters comes in parts: the result's `totalChars` is the whole page and `nextOffset` is where the next part starts (call again with `offset: nextOffset` (several offsets in parallel is fine) until there is no `nextOffset`. Read every part before summarising or quoting a whole page; never present a summary of part of a page as the page's. For a long DOCUMENT (a legal page, a story, docs) pass `toFile: true` instead: the whole cleaned text is saved in the sandbox in one call and you get its path, length and opening) then grep it or read it with readFile, in parallel ranges. Don't curl and convert HTML by hand.",
    inputSchema: z.object({
      toFile: z
        .boolean()
        .optional()
        .describe(
          'Save the whole page as text in the sandbox instead of returning a part of it.'
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Character offset to start from: a previous result's `nextOffset`. Omit for the start."
        ),
      url: z.string().url().describe('The URL to fetch.'),
    }),
    execute: async ({ offset, toFile, url }) => {
      try {
        if (!toFile) {
          return { ...(await fetchUrlText({ offset, url })), success: true };
        }
        const context = getSandboxContext();
        if (!context) {
          throw new Error(
            'No sandbox in this turn, so the page cannot be saved; fetch it without toFile and read it in parts.'
          );
        }
        const page = await fetchUrlText({ offset: 0, url, whole: true });
        const { hostname, pathname } = new URL(url);
        const name = `${hostname}${pathname}`
          .replaceAll(/[^\w.-]+/g, '_')
          .replace(/_+$/, '')
          .slice(0, 120);
        const path = nodePath.join(
          context.sessionWorkDir,
          'pages',
          `${name || 'page'}.txt`
        );
        await context.session.writeBinaryFile({
          content: new TextEncoder().encode(page.content),
          path,
        });
        return {
          contentType: page.contentType,
          lines: page.content.split('\n').length,
          path,
          preview: page.content.slice(0, SAVED_PREVIEW_CHARS),
          success: true,
          totalChars: page.totalChars,
          via: page.via,
        };
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, '[fetchUrl] failed');
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
