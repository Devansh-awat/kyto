import { randomBytes } from 'node:crypto';
import type { ThreadHandle } from '@/harness/thread';
import { LIVE_EMBED_PREFIX, publishEmbed, thumbnailUrl } from '@/lib/embeds';

// The live view, playing INSIDE the Slack message (owner's ask, 2026-10-02:
// "like whiteboards can it not render in slack?"). Slack's video block frames
// only a registered unfurl domain and the view lives on an E2B host, so kyto
// publishes a small page on its own domain that frames the view, and posts that.

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function framePage({ title, url }: { title: string; url: string }): string {
  const src = escapeAttribute(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeAttribute(title)}</title>
<style>html,body{margin:0;height:100%;background:#1a1d21}iframe{border:0;width:100%;height:100%}</style>
</head>
<body><iframe src="${src}" title="${escapeAttribute(title)}"></iframe></body>
</html>
`;
}

/**
 * Post a live view into the thread as an in-message player, with the plain link
 * as the fallback text. The user account can't post a video block (that needs
 * the app's embed scope), so where only it can post, it posts the link.
 */
export async function postLiveView({
  asUserAccount,
  thread,
  title,
  url,
}: {
  asUserAccount: boolean;
  thread: ThreadHandle;
  title: string;
  url: string;
}): Promise<void> {
  // Random: the page carries the view's password, exactly as the link does.
  const id = `${LIVE_EMBED_PREFIX}${randomBytes(9).toString('hex')}`;
  const pageUrl = await publishEmbed({ html: framePage({ title, url }), id });
  const markdown = `_${title}: [open the view](${url}) (watch-only, ends when this reply does)_`;
  await thread
    .post({
      blocks: [
        {
          alt_text: title,
          thumbnail_url: thumbnailUrl(),
          title: { text: title, type: 'plain_text' },
          title_url: url,
          type: 'video',
          video_url: pageUrl,
        },
      ],
      fallbackText: `${title}: ${url}`,
    })
    .catch(async (error: unknown) => {
      // The user account can be in a channel the app is not.
      if (!asUserAccount) {
        throw error;
      }
      await thread.post({ fromUserAccount: true, markdown });
    });
}
