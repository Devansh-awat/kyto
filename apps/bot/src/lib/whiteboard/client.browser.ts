// The whiteboard page's browser half. Bundled by lib/whiteboard/page.ts and
// served from kyto's own host, so a board loads nothing from a CDN: it opens
// even when a CDN is having a bad day, and the client can never drift from the
// version of the sync protocol the server speaks.
//
// Excluded from `tsc` in apps/bot/tsconfig.json — this is the one file in the
// bot that runs in a browser, and the bot's config has no DOM lib.

import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type BoardElement, mergeElements } from './merge';

// The same merge rule the server runs — imported, not reimplemented, because
// two copies of "which edit wins" that disagree is exactly how a shared canvas
// silently forks.

// Drawing fires onChange on nearly every pointer move. Batching to this keeps a
// scribble to a handful of messages instead of hundreds.
const SEND_INTERVAL_MS = 150;
const POINTER_INTERVAL_MS = 80;
// A cursor with nothing behind it goes stale; drop it rather than leave a ghost.
const PEER_TIMEOUT_MS = 15_000;

const NAMES = [
  'otter',
  'heron',
  'marten',
  'kestrel',
  'badger',
  'puffin',
  'lynx',
  'wren',
];
const COLORS = [
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#f08c00',
  '#9c36b5',
  '#0c8599',
];

interface Peer {
  color: string;
  lastSeen: number;
  pointer?: { x: number; y: number };
  username: string;
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

const config = JSON.parse(
  document.getElementById('kyto-whiteboard')?.textContent ?? '{}'
) as { id?: string };

// Derived from the page's own location rather than baked in at publish time, so
// a board keeps working if the public host ever changes.
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/whiteboard/${config.id ?? ''}`;

const me = { color: pick(COLORS), username: pick(NAMES) };

function Board() {
  const [api, setApi] = useState<ExcalidrawApi | null>(null);
  // The mirror of the board this client believes in. Both halves of sync work
  // through it: remote messages merge in, local changes are diffed against it.
  const board = useRef(new Map<string, BoardElement>());
  const peers = useRef(new Map<string, Peer>());
  const socket = useRef<WebSocket | null>(null);
  const lastSent = useRef(0);
  const lastPointer = useRef(0);
  const pending = useRef(false);

  const paintPeers = useCallback((excalidraw: ExcalidrawApi) => {
    const collaborators = new Map<string, unknown>();
    const now = Date.now();
    for (const [id, peer] of peers.current) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peers.current.delete(id);
        continue;
      }
      collaborators.set(id, {
        color: { background: peer.color, stroke: peer.color },
        pointer: peer.pointer,
        username: peer.username,
      });
    }
    excalidraw.updateScene({ collaborators });
  }, []);

  useEffect(() => {
    if (!api) {
      return;
    }
    const connection = new WebSocket(socketUrl);
    socket.current = connection;
    connection.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'init' || message.type === 'update') {
        const applied = mergeElements({
          board: board.current,
          incoming: message.elements ?? [],
        });
        if (applied.length === 0 && message.type !== 'init') {
          return;
        }
        // captureUpdate NEVER: someone else's edit must not land in MY undo
        // stack, or ctrl-z starts undoing other people's work.
        api.updateScene({
          captureUpdate: CaptureUpdateAction.NEVER,
          elements: [...board.current.values()],
        });
        return;
      }
      if (message.type === 'pointer') {
        peers.current.set(message.id, {
          color: peers.current.get(message.id)?.color ?? pick(COLORS),
          lastSeen: Date.now(),
          pointer: message.pointer,
          username: message.name ?? 'someone',
        });
        paintPeers(api);
        return;
      }
      if (message.type === 'left') {
        peers.current.delete(message.id);
        paintPeers(api);
      }
    };
    const sweep = setInterval(() => paintPeers(api), PEER_TIMEOUT_MS / 2);
    return () => {
      clearInterval(sweep);
      connection.close();
    };
  }, [api, paintPeers]);

  const send = useCallback((elements: readonly BoardElement[]) => {
    const changed = mergeElements({ board: board.current, incoming: elements });
    if (changed.length === 0 || socket.current?.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.current.send(JSON.stringify({ elements: changed, type: 'update' }));
  }, []);

  const onChange = useCallback(() => {
    if (!api || pending.current) {
      return;
    }
    const wait = Math.max(
      0,
      SEND_INTERVAL_MS - (Date.now() - lastSent.current)
    );
    pending.current = true;
    setTimeout(() => {
      pending.current = false;
      lastSent.current = Date.now();
      // INCLUDING deleted: an erase is an element with `isDeleted` and a higher
      // version, and dropping it would leave the shape on everyone else's board.
      send(api.getSceneElementsIncludingDeleted() as BoardElement[]);
    }, wait);
  }, [api, send]);

  const onPointerUpdate = useCallback(({ x, y }: { x: number; y: number }) => {
    const now = Date.now();
    if (
      now - lastPointer.current < POINTER_INTERVAL_MS ||
      socket.current?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    lastPointer.current = now;
    socket.current.send(
      JSON.stringify({
        name: me.username,
        pointer: { x, y },
        type: 'pointer',
      })
    );
  }, []);

  return createElement(Excalidraw, {
    excalidrawAPI: setApi,
    isCollaborating: true,
    name: me.username,
    onChange,
    onPointerUpdate,
  });
}

interface ExcalidrawApi {
  getSceneElementsIncludingDeleted: () => readonly unknown[];
  updateScene: (scene: Record<string, unknown>) => void;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(createElement(Board));
}
