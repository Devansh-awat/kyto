import { randomBytes } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import { z } from 'zod';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

/**
 * The watch-only live view of the owner's Slack browser: Chromium's own
 * screencast (CDP `Page.startScreencast`), relayed as JPEG frames to a small
 * page on kyto's domain. View-only by construction — nothing a viewer sends is
 * read, so there is no input path to lock down, unlike a VNC stream whose
 * view-only flag has to be set right on the server. The link is a capability
 * (a random id) and dies with the session.
 */

export const SLACK_VIEW_PREFIX = '/_slackview/';
const SOCKET_SUFFIX = '/socket';
const FRAME_QUALITY = 60;
const MAX_FRAME_WIDTH = 1440;
const MAX_FRAME_HEIGHT = 900;
const CDP_TIMEOUT_MS = 15_000;

export interface SlackViewSocketData {
  kind: 'slack-view';
  viewId: string;
}

const cdpMessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});
const targetInfoSchema = z.object({
  targetId: z.string(),
  type: z.string(),
});
const frameSchema = z.object({ data: z.string(), sessionId: z.number() });

/** Follows the newest page of one Chromium and fans its frames out. */
class ScreencastHub {
  private readonly viewers = new Set<ServerWebSocket<SlackViewSocketData>>();
  private socket: WebSocket | undefined;
  // Set synchronously, so viewers joining together share one CDP connection —
  // two would split the request ids and the frames between them.
  private connection: Promise<void> | undefined;
  private framesSent = 0;
  private nextId = 0;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private pageSession: string | undefined;
  private pageTarget: string | undefined;
  private readonly pages: string[] = [];
  private lastFrame: string | undefined;

  private readonly cdpPort: number;

  constructor(cdpPort: number) {
    this.cdpPort = cdpPort;
  }

  add(viewer: ServerWebSocket<SlackViewSocketData>): void {
    this.viewers.add(viewer);
    logger.info(
      { viewers: this.viewers.size },
      '[slack-browser] live view viewer joined'
    );
    if (this.lastFrame) {
      viewer.send(this.lastFrame);
    }
    if (this.connection) {
      return;
    }
    this.connection = this.connect().catch((error: unknown) => {
      this.connection = undefined;
      logger.warn(
        { error: errorMessage(error) },
        '[slack-browser] live view could not attach'
      );
    });
  }

  remove(viewer: ServerWebSocket<SlackViewSocketData>): void {
    this.viewers.delete(viewer);
    logger.info(
      { framesSent: this.framesSent, viewers: this.viewers.size },
      '[slack-browser] live view viewer left'
    );
  }

  close(): void {
    for (const viewer of this.viewers) {
      viewer.close(1000, 'The Slack browser closed.');
    }
    this.viewers.clear();
    this.socket?.close();
  }

  private call({
    method,
    params = {},
    sessionId,
  }: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<unknown> {
    const id = ++this.nextId;
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP is not connected for ${method}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private async connect(): Promise<void> {
    const version = z
      .object({ webSocketDebuggerUrl: z.string() })
      .parse(
        await (
          await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`)
        ).json()
      );
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    socket.addEventListener('message', (event) => {
      this.onMessage(String(event.data));
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    this.socket = socket;
    await this.call({
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    });
  }

  private onMessage(raw: string): void {
    const parsed = cdpMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.id !== undefined) {
      this.pending.get(message.id)?.(message.result);
      this.pending.delete(message.id);
      return;
    }
    if (
      message.method === 'Target.targetCreated' ||
      message.method === 'Target.targetDestroyed'
    ) {
      this.onTarget({ method: message.method, params: message.params });
    } else if (
      message.method === 'Page.screencastFrame' &&
      message.sessionId === this.pageSession
    ) {
      const frame = frameSchema.safeParse(message.params);
      if (!frame.success) {
        return;
      }
      this.broadcast(frame.data.data);
      this.call({
        method: 'Page.screencastFrameAck',
        params: { sessionId: frame.data.sessionId },
        sessionId: message.sessionId,
      }).catch(() => undefined);
    }
  }

  private broadcast(frame: string): void {
    if (this.framesSent === 0) {
      logger.info(
        { viewers: this.viewers.size },
        '[slack-browser] live view first frame'
      );
    }
    this.framesSent++;
    this.lastFrame = frame;
    for (const viewer of this.viewers) {
      viewer.send(frame);
    }
  }

  private onTarget({
    method,
    params,
  }: {
    method: string;
    params?: Record<string, unknown>;
  }): void {
    if (method === 'Target.targetDestroyed') {
      const targetId = z.string().safeParse(params?.targetId).data;
      const index = targetId ? this.pages.indexOf(targetId) : -1;
      if (index !== -1) {
        this.pages.splice(index, 1);
      }
      if (targetId === this.pageTarget) {
        this.follow(this.pages.at(-1));
      }
      return;
    }
    const info = targetInfoSchema.safeParse(params?.targetInfo);
    if (!info.success || info.data.type !== 'page') {
      return;
    }
    this.pages.push(info.data.targetId);
    // The newest tab is the one being worked in.
    this.follow(info.data.targetId);
  }

  private follow(targetId: string | undefined): void {
    if (!targetId || targetId === this.pageTarget) {
      return;
    }
    const previous = this.pageSession;
    this.pageTarget = targetId;
    this.pageSession = undefined;
    (async () => {
      if (previous) {
        await this.call({
          method: 'Target.detachFromTarget',
          params: { sessionId: previous },
        });
      }
      const attached = z.object({ sessionId: z.string() }).parse(
        await this.call({
          method: 'Target.attachToTarget',
          params: { flatten: true, targetId },
        })
      );
      if (this.pageTarget !== targetId) {
        return;
      }
      this.pageSession = attached.sessionId;
      logger.info({ targetId }, '[slack-browser] live view following a page');
      // The screencast only sends a frame when the page repaints, so a page
      // sitting idle would leave a new viewer blank; start them on a still.
      const still = z.object({ data: z.string() }).safeParse(
        await this.call({
          method: 'Page.captureScreenshot',
          params: { format: 'jpeg', quality: FRAME_QUALITY },
          sessionId: attached.sessionId,
        })
      );
      if (still.success && this.pageSession === attached.sessionId) {
        this.broadcast(still.data.data);
      }
      await this.call({
        method: 'Page.startScreencast',
        params: {
          format: 'jpeg',
          maxHeight: MAX_FRAME_HEIGHT,
          maxWidth: MAX_FRAME_WIDTH,
          quality: FRAME_QUALITY,
        },
        sessionId: attached.sessionId,
      });
    })().catch((error: unknown) => {
      logger.warn(
        { error: errorMessage(error) },
        '[slack-browser] live view could not follow the page'
      );
    });
  }
}

const views = new Map<string, ScreencastHub>();

/** Register a browser's view; returns its id and a function that ends it. */
export function registerLiveView(cdpPort: number): {
  id: string;
  end: () => void;
} {
  const id = randomBytes(24).toString('base64url');
  const hub = new ScreencastHub(cdpPort);
  views.set(id, hub);
  return {
    end: () => {
      views.delete(id);
      hub.close();
    },
    id,
  };
}

function viewerPage(socketPath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>kyto's Slack browser</title>
<style>html,body{margin:0;height:100%;background:#1a1d21;color:#ccc;font:14px system-ui,sans-serif}#v{width:100%;height:100%;object-fit:contain;display:block}#s{position:fixed;top:8px;left:8px;opacity:.8}</style>
</head>
<body><span id="s">Connecting…</span><img id="v" alt="">
<script>
const img = document.getElementById('v');
const status = document.getElementById('s');
const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + ${JSON.stringify(socketPath)});
socket.onopen = () => { status.textContent = 'Connected, waiting for the first frame…'; };
socket.onmessage = (event) => { status.textContent = ''; img.src = 'data:image/jpeg;base64,' + event.data; };
socket.onclose = (event) => { status.textContent = 'The live view closed (' + event.code + (event.reason ? ': ' + event.reason : '') + ').'; };
</script>
</body>
</html>
`;
}

/**
 * The viewer page and its socket, or null when the path is not ours or the
 * view is gone (an ended link is an ordinary 404). Undefined after an upgrade.
 */
export function handleSlackViewRequest({
  pathname,
  request,
  server,
}: {
  pathname: string;
  request: Request;
  server: Pick<Server<SlackViewSocketData>, 'upgrade'>;
}): Response | null | undefined {
  if (!pathname.startsWith(SLACK_VIEW_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(SLACK_VIEW_PREFIX.length);
  const isSocket = rest.endsWith(SOCKET_SUFFIX);
  const viewId = isSocket ? rest.slice(0, -SOCKET_SUFFIX.length) : rest;
  if (!views.has(viewId)) {
    return null;
  }
  if (isSocket) {
    const upgraded = server.upgrade(request, {
      data: { kind: 'slack-view', viewId },
    });
    logger.info({ upgraded }, '[slack-browser] live view socket requested');
    return upgraded
      ? undefined
      : new Response('Upgrade failed', { status: 400 });
  }
  return new Response(viewerPage(`${pathname}${SOCKET_SUFFIX}`), {
    headers: {
      'Cache-Control': 'no-store',
      // Framed by the /embeds/live-* page Slack's video block plays, so no
      // X-Frame-Options; there is nothing on it to click.
      'Content-Security-Policy':
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function isSlackViewSocket(
  socket: ServerWebSocket<object>
): socket is ServerWebSocket<SlackViewSocketData> {
  return 'kind' in socket.data && socket.data.kind === 'slack-view';
}

export const slackViewSocketHandlers = {
  close(socket: ServerWebSocket<SlackViewSocketData>): void {
    views.get(socket.data.viewId)?.remove(socket);
  },
  open(socket: ServerWebSocket<SlackViewSocketData>): void {
    const hub = views.get(socket.data.viewId);
    if (hub) {
      hub.add(socket);
    } else {
      socket.close(1000, 'The Slack browser closed.');
    }
  },
};
