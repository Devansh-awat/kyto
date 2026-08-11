// The whiteboard page's browser half. Bundled by lib/whiteboard/page.ts and
// served from kyto's own host, so a board loads nothing from a CDN: it opens
// even when esm.sh is having a bad day (it was, the day this was written, and
// the previous single-player page was built on it), and the client can never
// drift from the version of the sync protocol the server speaks.
//
// Excluded from `tsc` in apps/bot/tsconfig.json — this is the one file in the
// bot that runs in a browser, and the bot's config has no DOM lib.

import { useSync } from '@tldraw/sync';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { inlineBase64AssetStore, type TLAssetStore, Tldraw } from 'tldraw';

// An image dropped onto a board is stored INSIDE the document as base64: kyto
// has no public upload endpoint and is not growing one for this. Every viewer
// pays for it on load and it lands in the room snapshot on disk, so it is
// capped rather than left unbounded.
const MAX_INLINE_ASSET_BYTES = 512 * 1024;

const configElement = document.getElementById('kyto-whiteboard');
const config = JSON.parse(configElement?.textContent ?? '{}') as {
  id?: string;
};

// Derived from the page's own location rather than baked in at publish time, so
// a board keeps working if the public host ever changes.
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/whiteboard/${config.id ?? ''}`;

const assets: TLAssetStore = {
  ...inlineBase64AssetStore,
  upload: (asset, file, abortSignal) => {
    if (file.size > MAX_INLINE_ASSET_BYTES) {
      throw new Error(
        `That file is ${Math.round(file.size / 1024)}KB. Images on a kyto whiteboard live inside the board itself, so they have to be under ${MAX_INLINE_ASSET_BYTES / 1024}KB.`
      );
    }
    return inlineBase64AssetStore.upload(asset, file, abortSignal);
  },
};

function Board() {
  const store = useSync({ assets, uri: socketUrl });
  return createElement(Tldraw, { store });
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(createElement(Board));
}
