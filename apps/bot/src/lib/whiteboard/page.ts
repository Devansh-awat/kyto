// What a visitor's browser actually gets: kyto's own copy of the tldraw client,
// and the page that boots it.
//
// The whole bundle is built here, at runtime, with Bun's bundler (~150ms for
// ~2MB) and served from kyto's host. That is a deliberate change from the
// single-player page this replaces, which pulled tldraw from esm.sh on every
// open: a CDN in the path means a board can stop working for reasons nobody
// here can see or fix, and it makes the client's version of the sync protocol
// someone else's decision. Now the page and the sync server come out of the
// same `bun install`.

import { mkdir } from 'node:fs/promises';
import nodePath from 'node:path';
import logger from '@/lib/logger';
import { EMBED_SITE_NAME, siteRoot, siteUrl } from '@/lib/sites/paths';

// Shared by every board, under the embeds site so the existing static route
// serves it. The embed-id shape forbids `_`, so this can never collide with a
// board of the same name.
const ASSET_DIR = '_assets';
const SCRIPT_FILE = 'whiteboard.js';
const STYLESHEET_FILE = 'tldraw.css';

interface WhiteboardAssets {
  scriptUrl: string;
  stylesheetUrl: string;
}

let built: Promise<WhiteboardAssets> | undefined;

async function buildAssets(): Promise<WhiteboardAssets> {
  const directory = nodePath.join(siteRoot(EMBED_SITE_NAME), ASSET_DIR);
  await mkdir(directory, { recursive: true });

  const result = await Bun.build({
    // React ships both branches of this and picks at runtime; without it the
    // bundle carries the dev build, which is bigger and much slower.
    define: { 'process.env.NODE_ENV': '"production"' },
    entrypoints: [nodePath.join(import.meta.dir, 'client.browser.ts')],
    minify: true,
    target: 'browser',
  });
  const output = result.outputs[0];
  if (!(result.success && output)) {
    throw new AggregateError(result.logs, 'whiteboard client build failed');
  }
  const script = await output.text();
  await Bun.write(nodePath.join(directory, SCRIPT_FILE), script);

  const stylesheet = Bun.resolveSync('tldraw/tldraw.css', import.meta.dir);
  await Bun.write(
    nodePath.join(directory, STYLESHEET_FILE),
    Bun.file(stylesheet)
  );

  // The filenames stay stable so pages published by an older build keep
  // resolving; the version query is what stops a browser serving a cached
  // client against a newer sync server.
  const version = Bun.hash(script).toString(36);
  const base = `${siteUrl(EMBED_SITE_NAME)}${ASSET_DIR}/`;
  logger.info(
    { bytes: script.length, version },
    '[whiteboard] built the client bundle'
  );
  return {
    scriptUrl: `${base}${SCRIPT_FILE}?v=${version}`,
    stylesheetUrl: `${base}${STYLESHEET_FILE}?v=${version}`,
  };
}

/**
 * Build the client once per process, and hand back its URLs. Lazy on purpose:
 * a kyto that never posts a whiteboard never pays for the bundle.
 */
export function ensureWhiteboardAssets(): Promise<WhiteboardAssets> {
  built ??= buildAssets().catch((error: unknown) => {
    built = undefined;
    throw error;
  });
  return built;
}

export function renderWhiteboardPage({
  assets,
  id,
  title,
}: {
  assets: WhiteboardAssets;
  id: string;
  title: string;
}): string {
  // `id` is already a validated slug; the title is whatever the model wrote, so
  // it is stripped of anything that could close a tag rather than escaped.
  const safeTitle = title.replace(/[<&>"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<link rel="stylesheet" href="${assets.stylesheetUrl}"/>
<style>
  html, body { margin: 0; height: 100%; background: #101214; overflow: hidden; }
  #root { position: fixed; inset: 0; }
</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="kyto-whiteboard">${JSON.stringify({ id })}</script>
<script type="module" src="${assets.scriptUrl}"></script>
</body>
</html>
`;
}
