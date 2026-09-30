import type { Logger } from '@repo/logging/logger';

// The Slack client's own websocket, opened with kyto's user-account session.
// It exists for ONE thing the Web API cannot do: the "kyto is typing…"
// indicator, which a person's client sends over this socket (`rtm.connect` is
// refused to this enterprise's sessions). Opened on first use, closed when
// idle — a socket held open marks the account active.

const GATEWAY_URL = 'wss://wss-primary.slack.com/';
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 60_000;

export class UserAccountGateway {
  private readonly cookie: string;
  private readonly logger: Logger;
  private readonly token: string;
  private socket: Promise<WebSocket> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;

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
          type: 'typing',
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
      );
      this.armIdleClose();
    } catch (error) {
      this.logger.warn({ err: error }, '[user-gateway] typing failed');
    }
  }

  close(): void {
    clearTimeout(this.idleTimer);
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

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${GATEWAY_URL}?token=${encodeURIComponent(this.token)}`,
        { headers: { Cookie: this.cookie, Origin: 'https://app.slack.com' } }
      );
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Slack gateway did not say hello in time.'));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('message', (event) => {
        if (String(event.data).includes('"type":"hello"')) {
          clearTimeout(timer);
          resolve(socket);
        }
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('Slack gateway closed the connection.'));
        // A later pulse reconnects.
        this.socket = undefined;
      });
    });
  }

  private armIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
  }
}
