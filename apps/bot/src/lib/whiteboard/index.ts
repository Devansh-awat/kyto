// The socket half of a whiteboard, mounted on the sites Bun.serve — the only
// public HTTP kyto has.
//
// The protocol is four messages and deliberately small, because the merge rule
// (merge.ts) is what actually keeps two browsers agreeing:
//
//   server → client  init    the whole board, on join
//   client → server  update  the elements that just changed for me
//   server → client  update  the elements that just changed for someone else
//   both ways        pointer where a cursor is (ephemeral, never stored)
//
// The room is resolved BEFORE the upgrade rather than in `open`, because Bun
// does not wait for an async open handler: a board still loading from disk
// would drop the first messages and leave someone drawing into nothing.

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { isValidEmbedId } from '@/lib/embeds';
import logger from '@/lib/logger';
import { type BoardElement, mergeElements } from './merge';
import {
  getWhiteboardRoom,
  hasCapacity,
  isWhiteboardPublished,
  type OpenRoom,
  scheduleSave,
} from './room';

export const WHITEBOARD_SOCKET_PREFIX = '/whiteboard/';

// One Bun pub/sub topic per board; `ws.publish` reaches everyone else in it.
const topicFor = (boardId: string) => `whiteboard:${boardId}`;

export interface WhiteboardSocketData {
  boardId: string;
  room: OpenRoom;
  sessionId: string;
}

/** What a client may send. Anything else is ignored rather than trusted. */
interface ClientMessage {
  elements?: unknown;
  name?: unknown;
  pointer?: unknown;
  type?: unknown;
}

export async function upgradeWhiteboardSocket({
  request,
  server,
}: {
  request: Request;
  server: Server<WhiteboardSocketData>;
}): Promise<Response | undefined> {
  const url = new URL(request.url);
  const id = url.pathname
    .slice(WHITEBOARD_SOCKET_PREFIX.length)
    .replace(/\/+$/, '');
  if (!isValidEmbedId(id)) {
    return new Response('Not found', { status: 404 });
  }
  // Only a board kyto actually published can be opened. Without this check, any
  // URL of the right shape would mint a document on kyto's host.
  if (!(await isWhiteboardPublished(id))) {
    return new Response('No such whiteboard', { status: 404 });
  }
  const room = await getWhiteboardRoom(id);
  if (!room) {
    return new Response('Too many whiteboards are open right now', {
      status: 503,
    });
  }
  const data: WhiteboardSocketData = {
    boardId: id,
    room,
    sessionId: crypto.randomUUID(),
  };
  if (server.upgrade(request, { data })) {
    return;
  }
  return new Response('Expected a websocket upgrade', { status: 426 });
}

function handleUpdate(
  socket: ServerWebSocket<WhiteboardSocketData>,
  message: ClientMessage
): void {
  const { boardId, room } = socket.data;
  if (!Array.isArray(message.elements)) {
    return;
  }
  if (!hasCapacity(room)) {
    logger.warn({ id: boardId }, '[whiteboard] board is full, dropping edits');
    return;
  }
  const applied = mergeElements({
    board: room.elements,
    incoming: message.elements as BoardElement[],
  });
  if (applied.length === 0) {
    return;
  }
  socket.publish(
    topicFor(boardId),
    JSON.stringify({ elements: applied, type: 'update' })
  );
  scheduleSave(boardId);
}

export const whiteboardSocketHandlers: WebSocketHandler<WhiteboardSocketData> =
  {
    close(socket) {
      const { boardId, room, sessionId } = socket.data;
      room.sessions = Math.max(0, room.sessions - 1);
      socket.publish(
        topicFor(boardId),
        JSON.stringify({ id: sessionId, type: 'left' })
      );
      socket.unsubscribe(topicFor(boardId));
    },
    message(socket, raw) {
      if (typeof raw !== 'string') {
        return;
      }
      let message: ClientMessage;
      try {
        message = JSON.parse(raw) as ClientMessage;
      } catch {
        return;
      }
      if (message.type === 'update') {
        handleUpdate(socket, message);
        return;
      }
      if (message.type === 'pointer') {
        // Ephemeral by design: a cursor is never merged and never saved, it is
        // just forwarded to whoever else is looking.
        socket.publish(
          topicFor(socket.data.boardId),
          JSON.stringify({
            id: socket.data.sessionId,
            name: typeof message.name === 'string' ? message.name : undefined,
            pointer: message.pointer,
            type: 'pointer',
          })
        );
      }
    },
    open(socket) {
      const { boardId, room } = socket.data;
      room.sessions += 1;
      room.emptySince = undefined;
      socket.subscribe(topicFor(boardId));
      socket.send(
        JSON.stringify({
          elements: [...room.elements.values()],
          type: 'init',
        })
      );
      logger.debug({ id: boardId }, '[whiteboard] session joined');
    },
  };
