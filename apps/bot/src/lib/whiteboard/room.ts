// One shared drawing per board, and where it lives when nobody is looking at it.
//
// A room is just the authoritative set of elements plus the people currently
// connected. Everything about WHICH copy of an element wins is in merge.ts;
// this file is the bookkeeping around it: open, persist, close when idle.
//
// Persistence is deliberate rather than incidental — kyto is restarted after
// every change, and a board that emptied itself on `systemctl restart` would be
// worse than not having one.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import logger from '@/lib/logger';
import { sitesRoot } from '@/lib/sites/paths';
import type { BoardElement } from './merge';

// Under SITES_ROOT but NOT under the served `embeds` directory: a board is
// already public to anyone holding its URL, but there is no reason to also hand
// out the raw document as a downloadable file.
const BOARD_DIR = '.whiteboards';

// Drawing produces a burst of writes, so the save is debounced and lands
// through an atomic rename: a restart mid-write can never leave half a board.
const SAVE_DEBOUNCE_MS = 3000;

// A board nobody is in for this long is dropped from memory; the next visitor
// loads it back from disk.
const IDLE_CLOSE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// Ceilings. A board is a public socket, so both the number of live boards and
// the size of one are bounded rather than left to whoever is drawing.
const MAX_OPEN_ROOMS = 40;
const MAX_ELEMENTS = 20_000;

export interface OpenRoom {
  elements: Map<string, BoardElement>;
  /** When the room last had nobody in it, for the idle sweep. */
  emptySince?: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  sessions: number;
}

const rooms = new Map<string, OpenRoom>();
const opening = new Map<string, Promise<OpenRoom>>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function boardDir(): string {
  return nodePath.join(sitesRoot(), BOARD_DIR);
}

function boardPath(id: string, extension: string): string {
  return nodePath.join(boardDir(), `${id}.${extension}`);
}

/**
 * Marker written when a board is published. It is what makes a socket
 * connection legitimate: without it, any URL of the right shape would mint a
 * document on kyto's host, so a stranger could create boards kyto never posted.
 */
export async function registerWhiteboard(id: string): Promise<void> {
  await mkdir(boardDir(), { recursive: true });
  await writeFile(boardPath(id, 'board'), '');
}

export function isWhiteboardPublished(id: string): Promise<boolean> {
  return Bun.file(boardPath(id, 'board')).exists();
}

async function readElements(id: string): Promise<BoardElement[]> {
  const raw = await readFile(boardPath(id, 'json'), 'utf8').catch(() => null);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BoardElement[]) : [];
  } catch (error) {
    // A board that cannot be parsed opens empty rather than refusing to open: a
    // blank canvas is recoverable, a board that never loads is not.
    logger.warn({ err: error, id }, '[whiteboard] unreadable board, ignoring');
    return [];
  }
}

async function saveRoom(id: string, room: OpenRoom): Promise<void> {
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = undefined;
  }
  try {
    await mkdir(boardDir(), { recursive: true });
    const target = boardPath(id, 'json');
    const staging = `${target}.tmp`;
    await writeFile(staging, JSON.stringify([...room.elements.values()]));
    await rename(staging, target);
  } catch (error) {
    logger.warn({ err: error, id }, '[whiteboard] failed to save board');
  }
}

export function scheduleSave(id: string): void {
  const room = rooms.get(id);
  if (!room || room.saveTimer) {
    return;
  }
  room.saveTimer = setTimeout(() => {
    room.saveTimer = undefined;
    // saveRoom reports its own failures; a board that cannot be written is not
    // a reason to take the live one down.
    saveRoom(id, room);
  }, SAVE_DEBOUNCE_MS);
}

function sweepIdleRooms(): void {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.sessions > 0) {
      room.emptySince = undefined;
      continue;
    }
    room.emptySince ??= now;
    if (now - room.emptySince >= IDLE_CLOSE_MS) {
      logger.info({ id }, '[whiteboard] closing idle board');
      rooms.delete(id);
      saveRoom(id, room);
    }
  }
  if (rooms.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

async function openRoom(id: string): Promise<OpenRoom> {
  const stored = await readElements(id);
  const elements = new Map<string, BoardElement>();
  for (const element of stored) {
    if (typeof element?.id === 'string') {
      elements.set(element.id, element);
    }
  }
  return { elements, sessions: 0 };
}

/**
 * The one room for this board, loading it from disk if it isn't already live.
 * Null means the ceiling on open boards is reached — refuse the connection
 * rather than pretend.
 *
 * Concurrent opens collapse onto a single in-flight promise: two rooms for one
 * board would each think they were authoritative and drift apart.
 */
export async function getWhiteboardRoom(id: string): Promise<OpenRoom | null> {
  const live = rooms.get(id);
  if (live) {
    return live;
  }
  const inFlight = opening.get(id);
  if (inFlight) {
    return await inFlight;
  }
  if (rooms.size >= MAX_OPEN_ROOMS) {
    logger.warn({ id, open: rooms.size }, '[whiteboard] too many open boards');
    return null;
  }
  const pending = openRoom(id);
  opening.set(id, pending);
  try {
    const room = await pending;
    rooms.set(id, room);
    sweeper ??= setInterval(sweepIdleRooms, SWEEP_INTERVAL_MS);
    return room;
  } finally {
    opening.delete(id);
  }
}

/** True while the board still has room for more shapes. */
export function hasCapacity(room: OpenRoom): boolean {
  return room.elements.size < MAX_ELEMENTS;
}

/** Drop a board entirely: its live room, its saved contents and its marker. */
export async function deleteWhiteboard(id: string): Promise<void> {
  const room = rooms.get(id);
  if (room?.saveTimer) {
    clearTimeout(room.saveTimer);
  }
  rooms.delete(id);
  await Promise.all([
    rm(boardPath(id, 'json'), { force: true }),
    rm(boardPath(id, 'board'), { force: true }),
  ]);
}

/**
 * Write every open board out. Called on SIGTERM: kyto restarts after every
 * change, and without this the last few seconds of everyone's drawing — the
 * debounce window — would go with it.
 */
export async function flushWhiteboards(): Promise<void> {
  await Promise.all([...rooms].map(([id, room]) => saveRoom(id, room)));
}
