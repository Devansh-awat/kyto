// Live, interactive embeds inside a Slack message.
//
// Slack's `video` block is not really about video: it iframes whatever URL you
// give it, right inside the message, and lets people interact with it. That is
// how #coolton's "whiteboard" works — a video block pointing at a hosted tldraw
// page. Kyto already hosts static sites, so it can serve the page ITSELF rather
// than borrowing someone else's file server: one domain, nothing third-party in
// the path, and the page dies when kyto says so.
//
// Two costs, both paid deliberately:
//
//   - Slack requires `links.embed:write` AND the domain registered as an app
//     unfurl domain. Only `kyto.dino.icu` is registered, so kyto cannot be
//     talked into embedding an arbitrary site.
//   - An embed page must be FRAMEABLE, so the sites server's blanket
//     `X-Frame-Options: SAMEORIGIN` cannot apply to it. It is dropped for this
//     one directory and nowhere else — the dashboard in particular keeps it,
//     since a frameable password form is a clickjacking target.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { EMBED_SITE_NAME, siteRoot, siteUrl } from '@/lib/sites/paths';

// Big enough for a real single-file page (inlined CSS and JS), small enough
// that a runaway model cannot fill the disk one embed at a time.
export const MAX_EMBED_BYTES = 512 * 1024;

// Slack requires a thumbnail image for a video block, and it is what people see
// before they click. Served from kyto's own host so no third party sits in the
// path of every embed (coolton points at placehold.co); a 1280x720 SVG is
// enough, and Slack renders it.
const THUMBNAIL_FILE = 'thumbnail.svg';
const THUMBNAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#1a1d21"/>
  <text x="640" y="352" fill="#e8e8e8" font-family="Helvetica, Arial, sans-serif" font-size="52" text-anchor="middle">kyto</text>
  <text x="640" y="416" fill="#9aa0a6" font-family="Helvetica, Arial, sans-serif" font-size="30" text-anchor="middle">click to open</text>
</svg>
`;

/** Slug shape for one embed. Same DNS-label rule the site names use. */
const EMBED_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidEmbedId(id: string): boolean {
  return EMBED_ID.test(id);
}

function embedDir(id: string): string {
  // The id shape forbids `.` and `/`, so this cannot escape the embeds root.
  return nodePath.join(siteRoot(EMBED_SITE_NAME), id);
}

export function embedUrl(id: string): string {
  return siteUrl(EMBED_SITE_NAME, id);
}

export function thumbnailUrl(): string {
  return `${siteUrl(EMBED_SITE_NAME)}${THUMBNAIL_FILE}`;
}

/** Write the shared thumbnail once, at startup. */
export async function ensureEmbedAssets(): Promise<void> {
  const root = siteRoot(EMBED_SITE_NAME);
  await mkdir(root, { recursive: true });
  await writeFile(nodePath.join(root, THUMBNAIL_FILE), THUMBNAIL_SVG);
}

/**
 * Publish one page and return its public URL. Overwrites an existing embed with
 * the same id, which is what makes an embed editable: the message keeps its
 * block and the content behind it changes.
 */
export async function publishEmbed({
  html,
  id,
}: {
  html: string;
  id: string;
}): Promise<string> {
  const dir = embedDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(nodePath.join(dir, 'index.html'), html);
  return embedUrl(id);
}

export async function deleteEmbed(id: string): Promise<void> {
  await rm(embedDir(id), { force: true, recursive: true });
}
