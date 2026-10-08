import type { Logger } from '@repo/logging/logger';
import { z } from 'zod';

// The Slack client's own websocket, opened with kyto's user-account session.
// Two things go over it that the Web API cannot do for this account: the
// "kyto is typing…" indicator (`rtm.connect` is refused to this enterprise's
// sessions), and HEARING channel messages — the account's events app is sent
// its DMs only, so a channel the app isn't in (and can't be invited to, e.g.
// #slack-app-approvals answers `cant_invite`) was unreachable without it.
// While listening the socket stays open, so the account shows as active.

const GATEWAY_URL = 'wss://wss-primary.slack.com/';
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 60_000;
const PING_MS = 30_000;
// No frame at all (not even a pong) for this long = a half-open socket.
const STALE_MS = 2 * 60_000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 5 * 60_000;

const frameSchema = z.looseObject({ type: z.string() });
const authTestSchema = z.object({ url: z.string() });
const userBootSchema = z.object({
  workspaces: z.array(z.object({ domain: z.string(), id: z.string() })),
});

type GatewayEventHandler = (event: Record<string, unknown>) => void;

export class UserAccountGateway {
  private readonly cookie: string;
  private readonly logger: Logger;
  private readonly token: string;
  private socket: Promise<WebSocket> | undefined;
  private connected: WebSocket | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private lastFrameAt = 0;
  private onEvent: GatewayEventHandler | undefined;
  private nextId = 1;
  private gatewayUrl: string | undefined;

  constructor({
    cookie,
    logger,
    token,
  }: {
    /** The whole `Cookie` header, `d=…`. */
    cookie: string;
    logger: Logger;
    token: string;
  }) {
    this.cookie = cookie;
    this.logger = logger;
    this.token = token;
  }

  /** Keep the socket open for good and hand every event to `onEvent`. */
  listen(onEvent: GatewayEventHandler): void {
    this.onEvent = onEvent;
    clearTimeout(this.idleTimer);
    this.keepOpen();
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.keepAlive(), PING_MS);
  }

  /** One typing pulse; Slack shows it for a few seconds. Never throws. */
  async typing({
    channel,
    threadTs,
  }: {
    channel: string;
    threadTs?: string;
  }): Promise<void> {
    try {
      const socket = await this.open();
      socket.send(
        JSON.stringify({
          channel,
          id: this.nextId++,
          // `typing` is accepted without an error and shown to nobody.
          type: 'user_typing',
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
      );
      this.armIdleClose();
    } catch (error) {
      this.logger.warn({ err: error }, '[user-gateway] typing failed');
    }
  }

  close(): void {
    this.onEvent = undefined;
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    const pending = this.socket;
    this.socket = undefined;
    pending?.then((socket) => socket.close()).catch(() => undefined);
  }

  private open(): Promise<WebSocket> {
    this.socket ??= this.connect().catch((error: unknown) => {
      this.socket = undefined;
      throw error;
    });
    return this.socket;
  }

  private keepOpen(): void {
    this.open()
      .then(() => {
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.logger.info('[user-gateway] listening as the user account');
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, retryInMs: this.reconnectDelay },
          '[user-gateway] connect failed'
        );
        this.scheduleReconnect();
      });
  }

  private scheduleReconnect(): void {
    if (!this.onEvent || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.keepOpen();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private keepAlive(): void {
    const pending = this.socket;
    if (!pending) {
      return;
    }
    pending
      .then((socket) => {
        if (Date.now() - this.lastFrameAt > STALE_MS) {
          this.logger.warn('[user-gateway] socket went quiet; reconnecting');
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ id: this.nextId++, type: 'ping' }));
      })
      .catch(() => undefined);
  }

  /**
   * The URL the desktop client connects to: pinned to the workspace with
   * `gateway_server`. Without it the socket still RECEIVES events, but typing
   * sent over it never showed for anyone (found by testing against a client
   * whose indicator works, 2026-10-01). Falls back to the bare URL.
   */
  private async resolveGatewayUrl(): Promise<string> {
    if (this.gatewayUrl) {
      return this.gatewayUrl;
    }
    const call = async (url: string, fields: Record<string, string> = {}) =>
      (
        await fetch(url, {
          body: new URLSearchParams({ token: this.token, ...fields }),
          headers: { Cookie: this.cookie },
          method: 'POST',
          // Unbounded, a stalled call left `open()` holding a promise that
          // never settled: no reconnect ever ran and the account stopped
          // listening until a restart.
          signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
        })
      ).json();
    try {
      const auth = authTestSchema.parse(
        await call('https://slack.com/api/auth.test')
      );
      const host = new URL(auth.url).hostname;
      const boot = userBootSchema.parse(
        await call(`https://${host}/api/client.userBoot`, {
          _x_app_name: 'client',
          _x_mode: 'online',
          _x_reason: 'client.userBoot',
          _x_sonic: 'true',
        })
      );
      const domain = host.split('.')[0];
      const workspace =
        boot.workspaces.find((candidate) => candidate.domain === domain) ??
        (boot.workspaces.length === 1 ? boot.workspaces[0] : undefined);
      if (!workspace) {
        throw new Error(`client.userBoot listed no workspace for ${host}.`);
      }
      const query = new URLSearchParams({
        flannel: '3',
        gateway_server: workspace.id,
        lazy_channels: '1',
        slack_client: 'desktop',
        token: this.token,
      });
      this.gatewayUrl = `${GATEWAY_URL}?${query}`;
      return this.gatewayUrl;
    } catch (error) {
      this.logger.warn(
        { err: error },
        '[user-gateway] could not resolve the workspace gateway; typing may not show'
      );
      return `${GATEWAY_URL}?token=${encodeURIComponent(this.token)}`;
    }
  }

  private async connect(): Promise<WebSocket> {
    const url = await this.resolveGatewayUrl();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Cookie: this.cookie, Origin: 'https://app.slack.com' },
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Slack gateway did not say hello in time.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('message', (frame) => {
        this.lastFrameAt = Date.now();
        let json: unknown;
        try {
          json = JSON.parse(String(frame.data));
        } catch {
          return;
        }
        const parsed = frameSchema.safeParse(json);
        if (!parsed.success) {
          return;
        }
        if (parsed.data.type === 'hello') {
          clearTimeout(timer);
          this.connected = socket;
          resolve(socket);
          return;
        }
        this.onEvent?.(parsed.data);
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('Slack gateway closed the connection.'));
        // A socket that never said hello was already forgotten by `open`;
        // its late close must not drop the one that replaced it.
        if (this.connected !== socket) {
          return;
        }
        this.connected = undefined;
        this.socket = undefined;
        // Listening: come back on our own. Otherwise a later pulse reconnects.
        this.scheduleReconnect();
      });
    });
  }

  private armIdleClose(): void {
    clearTimeout(this.idleTimer);
    if (this.onEvent) {
      return;
    }
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }
}
