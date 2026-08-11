// What a visitor's browser actually gets: kyto's own copy of Excalidraw, and
// the page that boots it.
//
// The bundle is built here, at runtime, with Bun's bundler and served from
// kyto's host. That is deliberate: a CDN in the path means a board can stop
// working for reasons nobody here can see or fix, and it makes the client's
// half of the sync protocol someone else's decision. Excalidraw's fonts are
// copied out of the package for the same reason — by default it fetches them
// from unpkg at runtime.

import { cp, mkdir } from 'node:fs/promises';
import nodePath from 'node:path';
import logger from '@/lib/logger';
import { EMBED_SITE_NAME, siteRoot, siteUrl } from '@/lib/sites/paths';

// Shared by every board, under the embeds site so the existing static route
// serves it. The embed-id shape forbids `_`, so this can never collide with a
// board of the same name.
const ASSET_DIR = '_assets';
const SCRIPT_FILE = 'whiteboard.js';
const STYLESHEET_FILE = 'excalidraw.css';
// Excalidraw resolves fonts and its worker chunks against EXCALIDRAW_ASSET_PATH
// at runtime, expecting the package's own dist layout beneath it.
const VENDOR_DIRS = ['fonts', 'locales'] as const;

interface WhiteboardAssets {
  assetPath: string;
  scriptUrl: string;
  stylesheetUrl: string;
}

let built: Promise<WhiteboardAssets> | undefined;

async function buildAssets(): Promise<WhiteboardAssets> {
  const directory = nodePath.join(siteRoot(EMBED_SITE_NAME), ASSET_DIR);
  await mkdir(directory, { recursive: true });

  const result = await Bun.build({
    // React and Excalidraw both ship a dev and a prod branch and pick at
    // runtime; without this the bundle carries the slower, larger one.
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

  const distRoot = nodePath.dirname(
    Bun.resolveSync('@excalidraw/excalidraw', import.meta.dir)
  );
  await Bun.write(
    nodePath.join(directory, STYLESHEET_FILE),
    Bun.file(nodePath.join(distRoot, 'index.css'))
  );
  for (const dir of VENDOR_DIRS) {
    await cp(nodePath.join(distRoot, dir), nodePath.join(directory, dir), {
      recursive: true,
    });
  }

  // The filenames stay stable so pages published by an older build keep
  // resolving; the version query is what stops a browser serving a cached
  // client against a newer server.
  const version = Bun.hash(script).toString(36);
  const base = `${siteUrl(EMBED_SITE_NAME)}${ASSET_DIR}/`;
  logger.info(
    { bytes: script.length, version },
    '[whiteboard] built the client bundle'
  );
  return {
    assetPath: base,
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
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #root { position: fixed; inset: 0; }
</style>
<script>window.EXCALIDRAW_ASSET_PATH = ${JSON.stringify(assets.assetPath)};</script>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="kyto-whiteboard">${JSON.stringify({ id })}</script>
<script type="module" src="${assets.scriptUrl}"></script>
</body>
</html>
`;
}
