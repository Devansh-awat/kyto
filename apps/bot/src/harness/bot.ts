import type { Logger } from '@repo/logging/logger';
import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel } from '@slack/web-api';
import type { RawSlackMessage, SlackHarness } from './harness';
import { MemoryKV } from './kv';
import { ThreadHandle } from './thread';
import type {
  ActionEvent,
  AppHomeEvent,
  AssistantThreadEvent,
  Author,
  MemberJoinedEvent,
  Message,
  ModalSubmitEvent,
  ModalSubmitResult,
} from './types';

type ThreadMessageHandler = (
  thread: ThreadHandle,
  message: Message
) => Promise<void>;
type ActionHandler = (event: ActionEvent) => Promise<void>;
/** Returns what to say back, or undefined for the default greeting. */
type SlashCommandHandler = (command: {
  text: string;
  userId: string;
}) => Promise<string | undefined>;
type ModalSubmitHandler = (
  event: ModalSubmitEvent
) => Promise<ModalSubmitResult> | ModalSubmitResult;

const SEEN_EVENT_LIMIT = 1000;
// Message subtypes that still carry a real user message.
const ALLOWED_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

interface SocketEnvelope {
  ack: (response?: unknown) => Promise<void>;
  body: Record<string, unknown>;
  /** Envelope type from the 'slack_event' catch-all. */
  type?: string;
}

/**
 * kyto's own Slack app runtime: Socket Mode connection + event routing.
 * Replaces the chat-sdk `Chat` class. All handlers mirror the old names so
 * bot.ts and features port with minimal churn.
 */
export class KytoBot {
  /**
   * `user`: this connection carries events for kyto's Slack USER account (an
   * events-only app installed by that account), and a mention means a ping
   * of that account, not of the app.
   */
  readonly answersAs: 'app' | 'user';
  private readonly appToken: string;
  private readonly slackLogger: Logger;
  private readonly harness: SlackHarness;
  private readonly state = new MemoryKV();
  private socket: SocketModeClient | undefined;
  private readonly seenEvents = new Set<string>();

  private readonly mentionHandlers: ThreadMessageHandler[] = [];
  private readonly dmHandlers: ThreadMessageHandler[] = [];
  private readonly subscribedHandlers: ThreadMessageHandler[] = [];
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private slashHandler: SlashCommandHandler | undefined;
  private readonly modalHandlers = new Map<string, ModalSubmitHandler>();
  private readonly appHomeHandlers: ((event: AppHomeEvent) => Promise<void>)[] =
    [];
  private readonly assistantStartedHandlers: ((
    event: AssistantThreadEvent
  ) => Promise<void>)[] = [];
  private readonly assistantContextHandlers: ((
    event: AssistantThreadEvent
  ) => Promise<void>)[] = [];
  private readonly memberJoinedHandlers: ((
    event: MemberJoinedEvent
  ) => Promise<void>)[] = [];

  constructor({
    answersAs = 'app',
    appToken,
    harness,
    logger,
  }: {
    answersAs?: 'app' | 'user';
    appToken: string;
    harness: SlackHarness;
    logger: Logger;
  }) {
    this.answersAs = answersAs;
    this.appToken = appToken;
    this.harness = harness;
    this.slackLogger = logger;
  }

  // ── Handler registration (chat-sdk-compatible names) ────────────────────

  onNewMention(handler: ThreadMessageHandler): void {
    this.mentionHandlers.push(handler);
  }

  onDirectMessage(handler: ThreadMessageHandler): void {
    this.dmHandlers.push(handler);
  }

  onSubscribedMessage(handler: ThreadMessageHandler): void {
    this.subscribedHandlers.push(handler);
  }

  /**
   * Answer `/kyto …`. There is exactly one slash command registered, so this
   * takes the whole text and the app decides; the ACK is the reply, which is
   * why the handler returns a string rather than posting one (Slack gives 3
   * seconds, so nothing slow belongs in here).
   */
  onSlashCommand(handler: SlashCommandHandler): void {
    this.slashHandler = handler;
  }

  onAction(actionId: string | string[], handler: ActionHandler): void {
    for (const id of Array.isArray(actionId) ? actionId : [actionId]) {
      this.actionHandlers.set(id, handler);
    }
  }

  onModalSubmit(
    callbackId: string | string[],
    handler: ModalSubmitHandler
  ): void {
    for (const id of Array.isArray(callbackId) ? callbackId : [callbackId]) {
      this.modalHandlers.set(id, handler);
    }
  }

  onAppHomeOpened(handler: (event: AppHomeEvent) => Promise<void>): void {
    this.appHomeHandlers.push(handler);
  }

  onAssistantThreadStarted(
    handler: (event: AssistantThreadEvent) => Promise<void>
  ): void {
    this.assistantStartedHandlers.push(handler);
  }

  onAssistantContextChanged(
    handler: (event: AssistantThreadEvent) => Promise<void>
  ): void {
    this.assistantContextHandlers.push(handler);
  }

  onMemberJoinedChannel(
    handler: (event: MemberJoinedEvent) => Promise<void>
  ): void {
    this.memberJoinedHandlers.push(handler);
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  thread(threadId: string): ThreadHandle {
    return new ThreadHandle({
      harness: this.harness,
      id: threadId,
      logger: this.slackLogger,
    });
  }

  channel(channelId: string): ThreadHandle {
    const raw = channelId.startsWith('slack:')
      ? (channelId.split(':')[1] ?? channelId)
      : channelId;
    return this.thread(
      this.harness.encodeThreadId({ channel: raw, threadTs: '' })
    );
  }

  async openDM(user: Author | string): Promise<ThreadHandle> {
    const userId = typeof user === 'string' ? user : user.userId;
    const result = await this.harness.webClient.conversations.open({
      users: userId,
    });
    const channel = result.channel?.id;
    if (!channel) {
      throw new Error(`Failed to open a DM with ${userId}.`);
    }
    return this.channel(channel);
  }

  /** The DM between kyto's USER account and someone — not the app's DM. */
  async openUserAccountDM(userId: string): Promise<ThreadHandle> {
    const result = await this.harness
      .requireUserAccountClient()
      .conversations.open({ users: userId });
    const channel = result.channel?.id;
    if (!channel) {
      throw new Error(`Failed to open a user-account DM with ${userId}.`);
    }
    return this.channel(channel);
  }

  getUser(userId: string): Promise<Author> {
    return this.harness.getUser(userId);
  }

  getState(): MemoryKV {
    return this.state;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // The user-account connection shares the app's harness, whose identity
    // the app connection has already resolved.
    if (this.answersAs === 'app') {
      await this.harness.connectIdentity();
    }
    const socket = new SocketModeClient({
      appToken: this.appToken,
      logLevel: LogLevel.WARN,
    });
    this.socket = socket;

    // The client emits the INNER event type for events_api envelopes (never
    // 'events_api' itself), so route everything off the 'slack_event'
    // catch-all, which carries the envelope type alongside the payload.
    socket.on('slack_event', (envelope: SocketEnvelope) => {
      switch (envelope.type) {
        case 'events_api':
          this.handleEnvelope(envelope, () =>
            this.dispatchEvent(envelope.body)
          );
          return;
        case 'interactive':
          this.handleInteractive(envelope);
          return;
        case 'slash_commands':
          this.handleSlashCommand(envelope);
          return;
        default:
          envelope.ack().catch(() => undefined);
          return;
      }
    });

    await socket.start();
    this.slackLogger.info(
      { answersAs: this.answersAs },
      '[harness] socket mode connected'
    );
  }

  async shutdown(): Promise<void> {
    await this.socket?.disconnect();
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  private handleEnvelope(
    envelope: SocketEnvelope,
    run: () => Promise<void>
  ): void {
    // Ack first: Slack redelivers un-acked envelopes, and turns run long.
    envelope.ack().catch((error: unknown) => {
      this.slackLogger.warn({ err: error }, '[harness] event ack failed');
    });
    const eventId = String(envelope.body.event_id ?? '');
    if (eventId) {
      if (this.seenEvents.has(eventId)) {
        return;
      }
      this.seenEvents.add(eventId);
      if (this.seenEvents.size > SEEN_EVENT_LIMIT) {
        const oldest = this.seenEvents.values().next().value;
        if (oldest) {
          this.seenEvents.delete(oldest);
        }
      }
    }
    run().catch((error: unknown) => {
      this.slackLogger.error({ err: error }, '[harness] event handler failed');
    });
  }

  private async dispatchEvent(body: Record<string, unknown>): Promise<void> {
    const event = body.event as Record<string, unknown> | undefined;
    if (!event) {
      return;
    }
    switch (event.type) {
      case 'message':
        await this.dispatchMessage(event as RawSlackMessage);
        return;
      case 'app_home_opened':
        await runAll(this.appHomeHandlers, {
          userId: String(event.user ?? ''),
        });
        return;
      case 'assistant_thread_started':
      case 'assistant_thread_context_changed': {
        const assistantThread = event.assistant_thread as
          | { channel_id?: string; thread_ts?: string }
          | undefined;
        const payload = {
          channelId: assistantThread?.channel_id ?? '',
          threadTs: assistantThread?.thread_ts ?? '',
        };
        await runAll(
          event.type === 'assistant_thread_started'
            ? this.assistantStartedHandlers
            : this.assistantContextHandlers,
          payload
        );
        return;
      }
      case 'member_joined_channel':
        await runAll(this.memberJoinedHandlers, {
          channelId: String(event.channel ?? ''),
          inviter: event.inviter ? String(event.inviter) : undefined,
          userId: String(event.user ?? ''),
        });
        return;
      default:
        // app_mention is deliberately ignored: the matching `message` event
        // carries the same content and routing off one source avoids dupes.
        return;
    }
  }

  private async dispatchMessage(event: RawSlackMessage): Promise<void> {
    // Another app's post. Most modern apps post as their bot USER (no subtype,
    // `user` set), but webhooks and legacy integrations arrive as `bot_message`
    // with only a `bot_id`. Either may now reach kyto — the app decides which
    // to answer (lib/bot-pings) — but kyto's OWN custom-identity posts come
    // through this way too, and must never be mistaken for someone else's.
    const isBotPost = event.subtype === 'bot_message';
    if (event.subtype && !(ALLOWED_SUBTYPES.has(event.subtype) || isBotPost)) {
      return;
    }
    if (!(event.channel && event.ts)) {
      return;
    }
    let author: Author;
    if (event.user) {
      author = await this.harness.getUser(event.user);
    } else if (isBotPost && event.bot_id) {
      author = {
        isBot: true,
        isMe: event.bot_id === this.harness.botId,
        userId: event.bot_id,
        userName:
          typeof event.username === 'string' ? event.username : event.bot_id,
      };
    } else {
      return;
    }
    if (event.bot_id && event.bot_id === this.harness.botId) {
      author = { ...author, isBot: true, isMe: true };
    }
    const built = this.harness.buildMessage(event, author);
    const accountId = this.harness.userAccountId;
    const message =
      this.answersAs === 'user'
        ? {
            ...built,
            isMention: Boolean(
              accountId && (event.text ?? '').includes(`<@${accountId}>`)
            ),
          }
        : built;
    const thread = this.thread(message.threadId);
    // Only what is addressed to the account: it hears every message in every
    // channel it is in, and logging those would be a firehose.
    if (
      this.answersAs === 'user' &&
      (message.isMention || event.channel_type === 'im')
    ) {
      this.slackLogger.info(
        {
          channelType: event.channel_type,
          isMention: message.isMention,
          threadId: message.threadId,
          userId: author.userId,
        },
        '[user-account] message for the account'
      );
    }

    if (event.channel_type === 'im') {
      await runAll2(this.dmHandlers, thread, message);
      return;
    }
    if (message.isMention) {
      await runAll2(this.mentionHandlers, thread, message);
      return;
    }
    // Non-mention channel/group message: the subscribed handler gates on the
    // thread's stored respondOnThreadMessages state itself.
    await runAll2(this.subscribedHandlers, thread, message);
  }

  private handleSlashCommand(envelope: SocketEnvelope): void {
    const body = envelope.body;
    const text = typeof body.text === 'string' ? body.text : '';
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const reply = this.slashHandler
      ? this.slashHandler({ text, userId })
      : Promise.resolve(undefined);
    reply
      .then((answer) =>
        envelope.ack({
          response_type: 'ephemeral',
          text:
            answer ??
            "hi, i'm kyto! just @mention me in a channel or DM me — no slash command needed.",
        })
      )
      .catch((error: unknown) => {
        this.slackLogger.warn({ err: error }, '[harness] slash ack failed');
        return envelope.ack().catch(() => undefined);
      });
  }

  private handleInteractive(envelope: SocketEnvelope): void {
    const body = envelope.body;
    if (body.type === 'view_submission') {
      this.handleViewSubmission(envelope).catch((error: unknown) => {
        this.slackLogger.error(
          { err: error },
          '[harness] view submission failed'
        );
      });
      return;
    }
    // Everything else (block_actions) acks empty first.
    envelope.ack().catch((error: unknown) => {
      this.slackLogger.warn({ err: error }, '[harness] interactive ack failed');
    });
    if (body.type === 'block_actions') {
      this.handleBlockActions(body).catch((error: unknown) => {
        this.slackLogger.error({ err: error }, '[harness] action failed');
      });
    }
  }

  private async handleBlockActions(
    body: Record<string, unknown>
  ): Promise<void> {
    const actions = (body.actions ?? []) as {
      action_id?: string;
      selected_option?: { value?: string } | null;
      value?: string;
    }[];
    const container = (body.container ?? {}) as {
      channel_id?: string;
      message_ts?: string;
      thread_ts?: string;
    };
    const user = (body.user ?? {}) as { id?: string; username?: string };
    for (const action of actions) {
      const handler = action.action_id
        ? this.actionHandlers.get(action.action_id)
        : undefined;
      if (!handler) {
        continue;
      }
      const channel = container.channel_id;
      const threadId = channel
        ? this.harness.encodeThreadId({
            channel,
            threadTs: container.thread_ts || container.message_ts || '',
          })
        : '';
      await handler({
        actionId: action.action_id ?? '',
        messageId: container.message_ts,
        raw: body,
        thread: threadId ? this.thread(threadId) : undefined,
        threadId,
        triggerId: body.trigger_id ? String(body.trigger_id) : undefined,
        user: {
          userId: user.id ?? '',
          userName: user.username ?? user.id ?? '',
        },
        // A button carries `value`; a select reports `selected_option.value`.
        value: action.value ?? action.selected_option?.value ?? undefined,
      });
    }
  }

  private async handleViewSubmission(envelope: SocketEnvelope): Promise<void> {
    const body = envelope.body;
    const view = (body.view ?? {}) as {
      callback_id?: string;
      private_metadata?: string;
      state?: {
        values?: Record<string, Record<string, ModalStateElement>>;
      };
    };
    const handler = view.callback_id
      ? this.modalHandlers.get(view.callback_id)
      : undefined;
    if (!handler) {
      await envelope.ack();
      return;
    }
    const values: Record<string, string | undefined> = {};
    const multiValues: Record<string, string[]> = {};
    for (const [blockId, actions] of Object.entries(view.state?.values ?? {})) {
      const element = Object.values(actions)[0];
      values[blockId] = modalStateValue(element);
      multiValues[blockId] = modalStateValues(element);
    }
    const user = (body.user ?? {}) as { id?: string; username?: string };
    const result = await handler({
      callbackId: view.callback_id ?? '',
      privateMetadata: view.private_metadata,
      raw: body,
      triggerId: body.trigger_id ? String(body.trigger_id) : undefined,
      multiValues,
      user: { userId: user.id ?? '', userName: user.username ?? user.id ?? '' },
      values,
    });
    if (result?.action === 'errors') {
      await envelope.ack({ errors: result.errors, response_action: 'errors' });
      return;
    }
    if (result?.action === 'clear') {
      await envelope.ack({ response_action: 'clear' });
      return;
    }
    await envelope.ack();
  }
}

/**
 * One element of a submitted modal's state. A plain text input reports `value`,
 * but a select reports `selected_option.value` — reading only `value` silently
 * dropped every select in a modal (they arrived as undefined).
 */
interface ModalStateElement {
  selected_conversations?: string[] | null;
  selected_option?: { value?: string } | null;
  selected_options?: { value?: string }[] | null;
  value?: string | null;
}

function modalStateValue(element?: ModalStateElement): string | undefined {
  return element?.value ?? element?.selected_option?.value ?? undefined;
}

/**
 * The MULTI-select flavours, which report a list and no `value` at all. Kept
 * separate from `values` rather than joined into a string: a channel picker's
 * result is a set of ids, and re-splitting a delimiter-joined string is how a
 * channel whose id contains the delimiter would quietly go missing.
 */
function modalStateValues(element?: ModalStateElement): string[] {
  if (element?.selected_conversations) {
    return element.selected_conversations.filter(Boolean);
  }
  if (element?.selected_options) {
    return element.selected_options
      .map((option) => option.value)
      .filter((value): value is string => Boolean(value));
  }
  return [];
}

async function runAll<T>(
  handlers: ((event: T) => Promise<void>)[],
  event: T
): Promise<void> {
  await Promise.all(handlers.map((handler) => handler(event)));
}

async function runAll2(
  handlers: ThreadMessageHandler[],
  thread: ThreadHandle,
  message: Message
): Promise<void> {
  await Promise.all(handlers.map((handler) => handler(thread, message)));
}
