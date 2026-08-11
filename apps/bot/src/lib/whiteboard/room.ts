// One live, shared document per whiteboard, and where it lives when nobody is
// looking at it.
//
// `TLSocketRoom` is tldraw's own server: it holds the authoritative document,
// merges each client's pushes and fans the diffs back out. There must be
// exactly ONE instance per board — two would each think they were authoritative
// and quietly diverge — so every path here goes through `getWhiteboardRoom`,
// which de-duplicates concurrent opens through a single in-flight promise.
//
// Persistence is deliberate rather than incidental: kyto is restarted after
// every change, and a board that lost its contents on `systemctl restart` would
// be worse than the single-player page it replaces.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { type RoomSnapshot, TLSocketRoom } from '@tldraw/sync-core';
import logger from '@/lib/logger';
import { sitesRoot } from '@/lib/sites/paths';

// Under SITES_ROOT but NOT under the served `embeds` directory: a board's
// contents are already public to anyone holding its URL, but there is no reason
// to also serve the raw document as a downloadable file.
const BOARD_DIR = '.whiteboards';

// A drawing stroke lands as a record push, so writes are constant while someone
// is drawing. Debounced, with an atomic rename, so a restart mid-write can
// never leave half a board on disk.
const SAVE_DEBOUNCE_MS = 3000;

// A board nobody has been in for this long is closed and dropped from memory;
// the next visitor reloads it from disk. Rooms are cheap but not free, and this
// is what keeps a workspace's worth of boards from accumulating in the heap.
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// A ceiling on concurrently OPEN boards, so a flood of connections can't exhaust
// memory. Reaching it refuses new boards rather than evicting live ones.
const MAX_OPEN_ROOMS = 40;

// A board past this is not written back. Better a stale-but-loadable snapshot
// than a growing file that eventually eats the disk; the cause would be inlined
// image assets, which the client already caps at 512KB each.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

interface OpenRoom {
  /** When the room last had zero sessions, for the idle sweep. */
  emptySince?: number;
  room: TLSocketRoom;
  saveTimer?: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, OpenRoom>();
const opening = new Map<string, Promise<OpenRoom>>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function boardDir(): string {
  return nodePath.join(sitesRoot(), BOARD_DIR);
}

function snapshotPath(id: string): string {
  return nodePath.join(boardDir(), `${id}.json`);
}

/**
 * Marker written when a whiteboard is published. It is what makes a socket
 * connection legitimate: without it any URL shaped like a board id could open a
 * room on kyto's host, so a stranger could mint documents kyto never published.
 */
function markerPath(id: string): string {
  return nodePath.join(boardDir(), `${id}.board`);
}

export async function registerWhiteboard(id: string): Promise<void> {
  await mkdir(boardDir(), { recursive: true });
  await writeFile(markerPath(id), '');
}

export async function isWhiteboardPublished(id: string): Promise<boolean> {
  return await Bun.file(markerPath(id)).exists();
}

async function readSnapshot(id: string): Promise<RoomSnapshot | null> {
  const raw = await readFile(snapshotPath(id), 'utf8').catch(() => null);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as RoomSnapshot;
  } catch (error) {
    // A board that cannot be parsed starts empty rather than refusing to open:
    // a blank canvas is recoverable, a board that never loads is not.
    logger.warn(
      { err: error, id },
      '[whiteboard] unreadable snapshot, ignoring'
    );
    return null;
  }
}

async function saveRoom(id: string, entry: OpenRoom): Promise<void> {
  if (entry.saveTimer) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = undefined;
  }
  try {
    const json = JSON.stringify(entry.room.getCurrentSnapshot());
    if (json.length > MAX_SNAPSHOT_BYTES) {
      logger.warn(
        { bytes: json.length, id },
        '[whiteboard] board too large to save'
      );
      return;
    }
    await mkdir(boardDir(), { recursive: true });
    const target = snapshotPath(id);
    const staging = `${target}.tmp`;
    await writeFile(staging, json);
    await rename(staging, target);
  } catch (error) {
    logger.warn({ err: error, id }, '[whiteboard] failed to save board');
  }
}

function scheduleSave(id: string): void {
  const entry = rooms.get(id);
  if (!entry || entry.saveTimer) {
    return;
  }
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = undefined;
    // saveRoom reports its own failures; a board that cannot be written is not
    // a reason to take the live one down.
    saveRoom(id, entry);
  }, SAVE_DEBOUNCE_MS);
}

function closeRoom(id: string, entry: OpenRoom): void {
  // Dropped from the map FIRST: the save is async, and a visitor arriving
  // during it must get a fresh room rather than one that is about to close.
  rooms.delete(id);
  saveRoom(id, entry).finally(() => entry.room.close());
}

function sweepIdleRooms(): void {
  const now = Date.now();
  for (const [id, entry] of rooms) {
    if (entry.room.getNumActiveSessions() > 0) {
      entry.emptySince = undefined;
      continue;
    }
    entry.emptySince ??= now;
    if (now - entry.emptySince >= IDLE_CLOSE_MS) {
      logger.info({ id }, '[whiteboard] closing idle board');
      closeRoom(id, entry);
    }
  }
  if (rooms.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

async function openRoom(id: string): Promise<OpenRoom> {
  const snapshot = await readSnapshot(id);
  const room = new TLSocketRoom({
    log: {
      error: (...args: unknown[]) =>
        logger.warn({ args, id }, '[whiteboard] sync error'),
      warn: () => {
        // tldraw warns on every ordinary client hiccup (a reconnect, a stale
        // push). Kyto's journal is read by a human; only errors go in it.
      },
    },
    onCommittedChanges: () => scheduleSave(id),
  });
  if (snapshot) {
    room.loadSnapshot(snapshot);
  }
  return { room };
}

/**
 * The one room for this board, opening it from disk if it isn't already live.
 * Null means the ceiling on concurrent boards is reached — the caller should
 * refuse the connection rather than pretend.
 */
export async function getWhiteboardRoom(
  id: string
): Promise<TLSocketRoom | null> {
  const live = rooms.get(id);
  if (live && !live.room.isClosed()) {
    live.emptySince = undefined;
    return live.room;
  }
  const inFlight = opening.get(id);
  if (inFlight) {
    return (await inFlight).room;
  }
  if (rooms.size >= MAX_OPEN_ROOMS) {
    logger.warn({ id, open: rooms.size }, '[whiteboard] too many open boards');
    return null;
  }
  const pending = openRoom(id);
  opening.set(id, pending);
  try {
    const entry = await pending;
    rooms.set(id, entry);
    sweeper ??= setInterval(sweepIdleRooms, SWEEP_INTERVAL_MS);
    return entry.room;
  } finally {
    opening.delete(id);
  }
}

/** Drop a board entirely: its live room, its saved contents and its marker. */
export async function deleteWhiteboard(id: string): Promise<void> {
  const entry = rooms.get(id);
  if (entry) {
    rooms.delete(id);
    if (entry.saveTimer) {
      clearTimeout(entry.saveTimer);
    }
    entry.room.close();
  }
  await Promise.all([
    rm(snapshotPath(id), { force: true }),
    rm(markerPath(id), { force: true }),
  ]);
}

/**
 * Write every open board out. Called on SIGTERM: kyto restarts after every
 * change, and without this the last few seconds of everyone's drawing — the
 * debounce window — would go with it.
 */
export async function flushWhiteboards(): Promise<void> {
  await Promise.all([...rooms].map(([id, entry]) => saveRoom(id, entry)));
}
