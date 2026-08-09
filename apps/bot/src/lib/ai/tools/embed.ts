import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness';
import {
  deleteEmbed,
  embedUrl,
  isValidEmbedId,
  MAX_EMBED_BYTES,
  publishEmbed,
  thumbnailUrl,
} from '@/lib/embeds';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// A live page inside a Slack message. See lib/embeds for what Slack requires
// and why the page is hosted on kyto's own domain rather than a third party's.

// tldraw, loaded from its CDN as an ES module. Pinned: an embed published today
// must still open next month, and tldraw's latest tag has broken its own API
// between minors before.
const TLDRAW_VERSION = '3.7.0';

/**
 * A shared whiteboard page.
 *
 * tldraw's `persistenceKey` keeps the drawing in the VIEWER's browser, so this
 * is a board you can open, draw on, close and come back to — not a live
 * multiplayer canvas. That difference is stated on the page itself rather than
 * left for someone to discover: promising collaboration and delivering a
 * private copy is worse than promising nothing.
 */
function whiteboardPage(id: string, title: string): string {
  const safeTitle = title.replace(/[<&>]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<link rel="stylesheet" href="https://esm.sh/tldraw@${TLDRAW_VERSION}/tldraw.css"/>
<style>
  html, body, #root { margin: 0; height: 100%; background: #101214; }
  #note { position: fixed; bottom: 8px; left: 10px; z-index: 9; color: #9aa0a6;
          font: 12px Helvetica, Arial, sans-serif; pointer-events: none; }
</style>
</head>
<body>
<div id="root"></div>
<div id="note">kyto whiteboard · ${safeTitle} · saved in this browser, not shared live</div>
<script type="module">
  import React from 'https://esm.sh/react@18.3.1';
  import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
  import { Tldraw } from 'https://esm.sh/tldraw@${TLDRAW_VERSION}?deps=react@18.3.1,react-dom@18.3.1';
  createRoot(document.getElementById('root')).render(
    React.createElement(Tldraw, { persistenceKey: ${JSON.stringify(`kyto-${id}`)} })
  );
</script>
</body>
</html>
`;
}

export function embedTool({
  requestedBy,
  thread,
}: {
  requestedBy: string;
  thread: ThreadHandle;
}) {
  return tool({
    description:
      "Post a LIVE, interactive page inside a Slack message — it renders in the message itself and people can click and type in it, rather than following a link. Two kinds: `html`, where you write a complete self-contained HTML page (inline all CSS/JS; it is hosted on kyto's own domain), and `whiteboard`, which gives a tldraw drawing canvas. Use it for anything better seen than described: a chart, an interactive demo, a diagram people should be able to pan, a scratch canvas. ALWAYS set an explicit background-color AND text color in your CSS — the embed inherits nothing from Slack, so default-coloured text can come out invisible. Re-publishing the same `id` swaps what an existing embed shows; the Slack message keeps working. This is NOT a website people can keep visiting and sharing — use deploySite for that.",
    inputSchema: z.object({
      html: z
        .string()
        .max(MAX_EMBED_BYTES)
        .optional()
        .describe(
          'The complete HTML page, for kind "html". Self-contained: inline the CSS and JS.'
        ),
      id: z
        .string()
        .min(2)
        .max(60)
        .describe(
          'Slug for this embed, lowercase with hyphens. Reusing one replaces what that embed shows.'
        ),
      kind: z
        .enum(['html', 'whiteboard'])
        .default('html')
        .describe(
          '"html" for a page you wrote, "whiteboard" for a tldraw canvas.'
        ),
      post: z
        .boolean()
        .default(true)
        .describe(
          'Post it into this thread. False just publishes the page and returns the URL.'
        ),
      title: z
        .string()
        .max(150)
        .default('kyto embed')
        .describe('Title shown on the embed card in Slack.'),
    }),
    execute: async ({ html, id, kind, post, title }) => {
      const slug = id.trim().toLowerCase();
      if (!isValidEmbedId(slug)) {
        return {
          error:
            'Invalid id. Use lowercase letters, digits and hyphens, 2-63 characters.',
          published: false,
        };
      }
      if (kind === 'html' && !html?.trim()) {
        return {
          error: 'kind "html" needs an html page. Write the whole document.',
          published: false,
        };
      }
      try {
        const page =
          kind === 'whiteboard' ? whiteboardPage(slug, title) : (html ?? '');
        const url = await publishEmbed({ html: page, id: slug });
        if (!post) {
          return {
            published: true,
            summary: `Published the embed at ${url}. Not posted — call again with post:true, or link it.`,
            url,
          };
        }
        await thread.post({
          blocks: [
            {
              alt_text: title,
              thumbnail_url: thumbnailUrl(),
              title: { text: title, type: 'plain_text' },
              title_url: url,
              type: 'video',
              video_url: url,
            },
          ],
          // Block Kit needs a text fallback for notifications and for clients
          // that cannot render the block at all.
          fallbackText: `${title} — ${url}`,
        });
        logger.info({ id: slug, kind, requestedBy }, '[embed] posted');
        return {
          published: true,
          summary:
            kind === 'whiteboard'
              ? `Posted a whiteboard (${url}). Each person's drawing is saved in their own browser — it is a canvas to sketch on, not a shared live board, so say that rather than implying collaboration.`
              : `Posted the embed (${url}). It renders live in the message.`,
          url,
        };
      } catch (error) {
        logger.warn({ err: error, id: slug }, '[embed] failed');
        return { error: errorMessage(error), published: false };
      }
    },
  });
}

export function removeEmbedTool() {
  return tool({
    description:
      'Delete an embed page kyto published. The Slack message that carried it stays, but its card stops loading — so only do this when asked.',
    inputSchema: z.object({
      id: z.string().min(2).max(60).describe('The embed slug to delete.'),
    }),
    execute: async ({ id }) => {
      const slug = id.trim().toLowerCase();
      if (!isValidEmbedId(slug)) {
        return { error: 'Invalid id.', removed: false };
      }
      await deleteEmbed(slug);
      return {
        removed: true,
        summary: `Deleted the embed ${slug} (${embedUrl(slug)} is gone).`,
      };
    },
  });
}
