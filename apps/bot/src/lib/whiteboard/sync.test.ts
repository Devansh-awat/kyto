import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
  createTLSchema,
  DocumentRecordType,
  TLDOCUMENT_ID,
} from '@tldraw/tlschema';

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

// The wire version tldraw 5.3.0 speaks. Both halves of a board come out of the
// same install, so this is fixed; if it ever stops matching, the server answers
// `incompatibility_error` instead of `connect` and this test says so.
const SYNC_PROTOCOL_VERSION = 8;

const {
  deleteWhiteboard,
  flushWhiteboards,
  getWhiteboardRoom,
  registerWhiteboard,
} = await import('./room');
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

const HANDSHAKE_TIMEOUT_MS = 5000;

/** Open a socket, say hello the way tldraw's client does, and take the reply. */
function handshake(boardId: string): Promise<Record<string, unknown>> {
  const socket = new WebSocket(
    `ws://localhost:${server.port}/whiteboard/${boardId}?sessionId=test-session`
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('no reply from the sync server')),
      HANDSHAKE_TIMEOUT_MS
    );
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          connectRequestId: 'test-connect',
          lastServerClock: 0,
          protocolVersion: SYNC_PROTOCOL_VERSION,
          schema: createTLSchema().serialize(),
          type: 'connect',
        })
      );
    socket.onmessage = (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    };
  });
}

test('a published board accepts a sync session and hands over what is on it', async () => {
  await registerWhiteboard('board-one');
  const room = await getWhiteboardRoom('board-one');
  await room?.updateStore((store) => {
    store.put(
      DocumentRecordType.create({
        id: TLDOCUMENT_ID,
        name: 'Drawn before anyone connected',
      })
    );
  });

  const reply = await handshake('board-one');
  // The connect reply carrying the document is the whole point: the session
  // established, the schema was accepted, and the room answered with its state.
  expect(reply.type).toBe('connect');
  expect(reply.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
  expect(JSON.stringify(reply.diff)).toContain('Drawn before anyone connected');
});

test('the client bundle builds and lands next to its stylesheet', async () => {
  const { ensureWhiteboardAssets, renderWhiteboardPage } = await import(
    './page'
  );
  const assets = await ensureWhiteboardAssets();
  const built = nodePath.join(
    process.env.SITES_ROOT ?? '',
    'embeds',
    '_assets'
  );
  // Big enough to be tldraw rather than an empty module: a build that silently
  // produced nothing would still have "succeeded".
  expect(Bun.file(nodePath.join(built, 'whiteboard.js')).size).toBeGreaterThan(
    500_000
  );
  expect(Bun.file(nodePath.join(built, 'tldraw.css')).size).toBeGreaterThan(
    1000
  );
  const page = renderWhiteboardPage({
    assets,
    id: 'board-one',
    title: 'Plans',
  });
  expect(page).toContain('"board-one"');
  expect(page).toContain(assets.scriptUrl);
}, 30_000);

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
  const room = await getWhiteboardRoom('board-two');
  expect(room).not.toBeNull();
  await room?.updateStore((store) => {
    store.put(
      DocumentRecordType.create({
        id: TLDOCUMENT_ID,
        name: 'Drawn before the restart',
      })
    );
  });

  await flushWhiteboards();
  const snapshot = nodePath.join(
    process.env.SITES_ROOT ?? '',
    '.whiteboards',
    'board-two.json'
  );
  expect(await readFile(snapshot, 'utf8')).toContain(
    'Drawn before the restart'
  );

  await deleteWhiteboard('board-two');
  expect(await Bun.file(snapshot).exists()).toBe(false);
});
