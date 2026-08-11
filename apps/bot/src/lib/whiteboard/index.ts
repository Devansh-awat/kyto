// The socket half of a whiteboard, mounted on the sites Bun.serve — the only
// public HTTP kyto has.
//
// The room is resolved BEFORE the upgrade rather than in `open`, because Bun
// does not wait for an async open handler before delivering the first message:
// a board loaded from disk mid-handshake would drop the client's opening
// messages and leave it staring at a blank canvas.

import type { TLSocketRoom } from '@tldraw/sync-core';
import type { Server, WebSocketHandler } from 'bun';
import { isValidEmbedId } from '@/lib/embeds';
import logger from '@/lib/logger';
import { getWhiteboardRoom, isWhiteboardPublished } from './room';

export const WHITEBOARD_SOCKET_PREFIX = '/whiteboard/';

export interface WhiteboardSocketData {
  boardId: string;
  room: TLSocketRoom;
  sessionId: string;
}

/**
 * Take over a `/whiteboard/<id>` request as a sync socket. Returns undefined
 * once the socket is upgraded (which is what Bun's fetch handler expects), or a
 * Response explaining why it wasn't.
 */
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
  // Only a board kyto actually published can be opened. Without this check any
  // URL of the right shape would mint a document on kyto's host, so a stranger
  // could fill the disk with boards nobody asked for.
  if (!(await isWhiteboardPublished(id))) {
    return new Response('No such whiteboard', { status: 404 });
  }
  const room = await getWhiteboardRoom(id);
  if (!room) {
    return new Response('Too many whiteboards are open right now', {
      status: 503,
    });
  }
  // tldraw's client appends its own sessionId; the fallback is for anything
  // else that connects, so two clients can never share a session.
  const sessionId = url.searchParams.get('sessionId') ?? crypto.randomUUID();
  const data: WhiteboardSocketData = { boardId: id, room, sessionId };
  if (server.upgrade(request, { data })) {
    return;
  }
  return new Response('Expected a websocket upgrade', { status: 426 });
}

export const whiteboardSocketHandlers: WebSocketHandler<WhiteboardSocketData> =
  {
    close(ws) {
      ws.data.room.handleSocketClose(ws.data.sessionId);
    },
    message(ws, message) {
      ws.data.room.handleSocketMessage(ws.data.sessionId, message);
    },
    open(ws) {
      // The room can only have closed in the moments between the upgrade and
      // here (its last session left and the sweep ran). 1012 is "service
      // restart", which tells the client to reconnect — and the reconnect will
      // open the board again from disk.
      if (ws.data.room.isClosed()) {
        ws.close(1012, 'reconnecting');
        return;
      }
      logger.debug({ id: ws.data.boardId }, '[whiteboard] session joined');
      ws.data.room.handleSocketConnect({
        sessionId: ws.data.sessionId,
        socket: ws,
      });
    },
  };
