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
import {
  ensureWhiteboardAssets,
  renderWhiteboardPage,
} from '@/lib/whiteboard/page';
import { deleteWhiteboard, registerWhiteboard } from '@/lib/whiteboard/room';

// A live page inside a Slack message. See lib/embeds for what Slack requires
// and why the page is hosted on kyto's own domain rather than a third party's,
// and lib/whiteboard for how a board is shared between the people drawing on it.
//
// The whiteboard was tldraw once. It is Excalidraw (MIT) now, because tldraw's
// licence forbids use in a "Production Environment" — anything serving end
// users — without a paid key, and 5.x enforces that by replacing the editor
// with a blank page five seconds after it loads anywhere but localhost. Do NOT
// bring tldraw back by pinning an older version: same licence, and it also says
// not to interfere with the key enforcement.

export function embedTool({
  requestedBy,
  thread,
}: {
  requestedBy: string;
  thread: ThreadHandle;
}) {
  return tool({
    description:
      "Post a LIVE, interactive page inside a Slack message — it renders in the message itself and people can click and type in it, rather than following a link. Two kinds: `html`, where you write a complete self-contained HTML page (inline all CSS/JS; it is hosted on kyto's own domain), and `whiteboard`, a real-time SHARED drawing canvas — everyone who opens it is on the same board, sees each other's cursors live, and what they draw is kept between visits, so it is a good answer when people want to sketch something out together. Use it for anything better seen than described: a chart, an interactive demo, a diagram people should be able to pan, a scratch canvas. ALWAYS set an explicit background-color AND text color in your CSS — the embed inherits nothing from Slack, so default-coloured text can come out invisible. Re-publishing the same `id` swaps what an existing embed shows; the Slack message keeps working. This is NOT a website people can keep visiting and sharing — use deploySite for that.",
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
          '"html" for a page you wrote, "whiteboard" for a shared live drawing canvas everyone in the channel edits together.'
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
        let page = html ?? '';
        if (kind === 'whiteboard') {
          const assets = await ensureWhiteboardAssets();
          page = renderWhiteboardPage({ assets, id: slug, title });
          // Before publishing: the marker is what lets the sync socket open
          // this board, and a page that loads before it exists cannot connect.
          await registerWhiteboard(slug);
        }
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
              ? `Posted a whiteboard (${url}). It is genuinely shared: everyone in the channel draws on the same board and sees each other's cursors as it happens, and it is kept between visits.`
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
      // A whiteboard also has a saved drawing and a marker; deleting only the
      // page would leave both behind, and everything drawn on it on disk.
      await deleteWhiteboard(slug);
      return {
        removed: true,
        summary: `Deleted the embed ${slug} (${embedUrl(slug)} is gone).`,
      };
    },
  });
}
