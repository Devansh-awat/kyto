import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

// The room writes under SITES_ROOT, so point it at a scratch directory BEFORE
// anything reads the env — @/env validates and freezes the whole environment at
// import time, which is also why the service keys below are stubbed: this test
// runs from the repo root, where apps/bot/.env is not loaded, and it needs none
// of them to talk to a websocket.
process.env.SITES_ROOT = await mkdtemp(nodePath.join(tmpdir(), 'kyto-boards-'));
process.env.SLACK_BOT_TOKEN ??= 'xoxb-test';
process.env.SLACK_SIGNING_SECRET ??= 'test-signing-secret';
process.env.SLACK_APP_TOKEN ??= 'xapp-test';
process.env.E2B_API_KEY ??= 'e2b-test';
process.env.HACKCLUB_API_KEY ??= 'sk-hc-test';
process.env.EXA_API_KEY ??= 'exa-test';
process.env.DATABASE_URL ??= 'postgres://test/test';

const { deleteWhiteboard, flushWhiteboards, registerWhiteboard } = await import(
  './room'
);
const { upgradeWhiteboardSocket, whiteboardSocketHandlers } = await import(
  './index'
);

const server = Bun.serve({
  fetch: (request, self) => upgradeWhiteboardSocket({ request, server: self }),
  port: 0,
  websocket: whiteboardSocketHandlers,
});

afterAll(() => {
  server.stop(true);
});

const REPLY_TIMEOUT_MS = 5000;

function open(boardId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://localhost:${server.port}/whiteboard/${boardId}`
  );
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('could not open the socket'));
  });
}

/** The next message of `type`, ignoring anything else on the wire. */
function next(
  socket: WebSocket,
  type: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${type} message arrived`)),
      REPLY_TIMEOUT_MS
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === type) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

const shape = (version: number) => ({
  id: 'rect-1',
  text: 'drawn by someone',
  version,
  versionNonce: 7,
});

test('what one person draws reaches everyone else on the board', async () => {
  await registerWhiteboard('board-one');
  const alice = await open('board-one');
  const bob = await open('board-one');
  await next(bob, 'init');

  const relayed = next(bob, 'update');
  alice.send(JSON.stringify({ elements: [shape(1)], type: 'update' }));
  expect(JSON.stringify((await relayed).elements)).toContain(
    'drawn by someone'
  );

  // And someone arriving later gets it without anyone re-sending anything.
  const carol = await open('board-one');
  expect(JSON.stringify((await next(carol, 'init')).elements)).toContain(
    'drawn by someone'
  );
  for (const socket of [alice, bob, carol]) {
    socket.close();
  }
});

test('a board kyto never published is refused', async () => {
  const response = await fetch(
    `http://localhost:${server.port}/whiteboard/never-published`
  );
  expect(response.status).toBe(404);
});

test('a malformed board id is refused', async () => {
  const response = await fetch(
    `http://localhost:${server.port}/whiteboard/..%2f..%2fetc`
  );
  expect(response.status).toBe(404);
});

test('what is drawn survives a restart, and delete takes it away', async () => {
  await registerWhiteboard('board-two');
  const socket = await open('board-two');
  await next(socket, 'init');
  socket.send(JSON.stringify({ elements: [shape(3)], type: 'update' }));
  // The server applies a message when it arrives, not when it was sent.
  await Bun.sleep(100);
  socket.close();

  await flushWhiteboards();
  const saved = nodePath.join(
    process.env.SITES_ROOT ?? '',
    '.whiteboards',
    'board-two.json'
  );
  expect(await readFile(saved, 'utf8')).toContain('drawn by someone');

  await deleteWhiteboard('board-two');
  expect(await Bun.file(saved).exists()).toBe(false);
});

test('the client bundle builds, with its fonts and stylesheet beside it', async () => {
  const { ensureWhiteboardAssets, renderWhiteboardPage } = await import(
    './page'
  );
  const assets = await ensureWhiteboardAssets();
  const built = nodePath.join(
    process.env.SITES_ROOT ?? '',
    'embeds',
    '_assets'
  );
  // Big enough to be Excalidraw rather than an empty module: a build that
  // silently produced nothing would still have "succeeded".
  expect(Bun.file(nodePath.join(built, 'whiteboard.js')).size).toBeGreaterThan(
    500_000
  );
  expect(Bun.file(nodePath.join(built, 'excalidraw.css')).size).toBeGreaterThan(
    1000
  );
  // Excalidraw fetches these at runtime from EXCALIDRAW_ASSET_PATH; without the
  // copy the board renders with no text at all.
  const fonts = await readdir(nodePath.join(built, 'fonts', 'Excalifont'));
  expect(fonts.some((file) => file.endsWith('.woff2'))).toBe(true);

  const page = renderWhiteboardPage({
    assets,
    id: 'board-one',
    title: 'Plans',
  });
  expect(page).toContain('"board-one"');
  expect(page).toContain(assets.scriptUrl);
  expect(page).toContain('EXCALIDRAW_ASSET_PATH');
}, 60_000);
