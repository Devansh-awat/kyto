import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  claimEventFire,
  claimEventMark,
  getReminder,
  listActiveEventReminders,
  type Reminder,
  type ReminderKind,
  type ReminderTrigger,
} from '@repo/db/queries';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot as Chat } from '@/harness/bot';
import { isUserAllowed } from '@/lib/allowed-users';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { fireReminder } from '@/lib/reminders/scheduler';
import { mayReadChannel } from '@/lib/slack/channel-access';
import { errorMessage } from '@/lib/utils/error';

// Reminders that fire on something happening (owner's ask, 2026-10-11): a
// Slack message or reaction in a channel, or a POST to a secret webhook URL —
// a plain one, or GitHub's, whose signature is checked with the same secret.
// Matching runs against an in-memory copy of the active event reminders,
// refreshed every 30s and right after one is created or changed, because a
// DB query per Slack message would be one per message kyto can see.
const REFRESH_INTERVAL_MS = 30_000;
// Two events in one burst (a flurry of messages, a GitHub push of ten
// commits) fire a reminder once; a 'bash' or 'agent' fire is a sandbox or a
// model run, so those wait longer.
export const EVENT_COOLDOWN_SECONDS_BY_KIND: Record<ReminderKind, number> = {
  agent: 10 * 60,
  bash: 5 * 60,
  message: 60,
  script: 60,
};
const PAYLOAD_MAX_CHARS = 6000;
const MATCH_TEXT_MAX_CHARS = 4000;
const WEBHOOK_BODY_MAX_BYTES = 1_000_000;
const WEBHOOK_PREFIX = '/_hooks/';

let bot: Chat | undefined;
let cache: Reminder[] = [];

export async function refreshEventReminders(): Promise<void> {
  cache = await listActiveEventReminders().catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error) },
      '[reminders] could not load event reminders'
    );
    return cache;
  });
}

export function startEventReminders(chat: Chat): void {
  bot = chat;
  refreshEventReminders();
  setInterval(refreshEventReminders, REFRESH_INTERVAL_MS).unref();
}

export function webhookUrl(reminder: Reminder): string {
  const base = `https://${env.SITES_PUBLIC_HOST}${WEBHOOK_PREFIX}${reminder.id}`;
  return reminder.trigger?.source === 'webhook'
    ? `${base}/${reminder.webhookSecret ?? ''}`
    : base;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [cut]` : text;
}

/** A user-written pattern: a case-insensitive substring, or a regex. */
export function patternMatches({
  pattern,
  regex,
  text,
}: {
  pattern?: string;
  regex?: boolean;
  text: string;
}): boolean {
  if (!pattern) {
    return true;
  }
  const haystack = text.slice(0, MATCH_TEXT_MAX_CHARS);
  if (!regex) {
    return haystack.toLowerCase().includes(pattern.toLowerCase());
  }
  try {
    return new RegExp(pattern, 'i').test(haystack);
  } catch {
    return false;
  }
}

async function fire({
  onceKey,
  reminder,
  payload,
  summary,
}: {
  /**
   * A threshold trigger's message or thread: it fires once per key, so the
   * burst cooldown would only drop a second message crossing it.
   */
  onceKey?: string;
  payload: string;
  reminder: Reminder;
  summary: string;
}): Promise<void> {
  if (!bot) {
    return;
  }
  if (
    onceKey &&
    !(await claimEventMark({ key: onceKey, reminderId: reminder.id }).catch(
      () => false
    ))
  ) {
    return;
  }
  const claimed = await claimEventFire({
    cooldownMs: onceKey
      ? 0
      : EVENT_COOLDOWN_SECONDS_BY_KIND[reminder.kind] * 1000,
    reminder,
  }).catch(() => false);
  if (!claimed) {
    return;
  }
  logger.info(
    { reminderId: reminder.id, source: reminder.trigger?.source },
    '[reminders] event reminder fired'
  );
  // A run cap may just have ended it; the next refresh drops it anyway.
  refreshEventReminders();
  await fireReminder({
    bot,
    event: { payload: clip(payload, PAYLOAD_MAX_CHARS), summary },
    reminder,
  }).catch((error: unknown) => {
    logger.error(
      { err: errorMessage(error), reminderId: reminder.id },
      '[reminders] event reminder failed'
    );
  });
}

/** Its creator must still be able to read the channel it watches. */
async function creatorMayWatch({
  channel,
  reminder,
}: {
  channel: string;
  reminder: Reminder;
}): Promise<boolean> {
  return await mayReadChannel({
    askerUserId: reminder.userId,
    channelId: channel,
    currentChannelId: undefined,
  });
}

async function permalink(channel: string, ts: string): Promise<string> {
  try {
    const result = await slack.webClient.chat.getPermalink({
      channel,
      message_ts: ts,
    });
    return result.permalink ?? `${channel}/${ts}`;
  } catch {
    return `${channel}/${ts}`;
  }
}

const messageEventSchema = z.looseObject({
  bot_id: z.string().optional(),
  channel: z.string(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string(),
  user: z.string().optional(),
});
// New messages only: an edit, a deletion or a join notice is not "a message".
const MESSAGE_SUBTYPES = new Set([
  undefined,
  'bot_message',
  'file_share',
  'thread_broadcast',
]);

const isKyto = (user: string | undefined, botId: string | undefined) =>
  (user !== undefined &&
    (user === slack.botUserId || user === slack.userAccountId)) ||
  (botId !== undefined && botId === slack.botId);

/** A Slack `message` event; never awaited by the event loop. */
export async function onSlackMessage(rawEvent: unknown): Promise<void> {
  if (cache.length === 0) {
    return;
  }
  const parsed = messageEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return;
  }
  const {
    bot_id: botId,
    channel,
    subtype,
    text = '',
    thread_ts: threadTs,
    ts,
    user,
  } = parsed.data;
  // kyto's own posts never trigger one, so two reminders can't feed each other.
  if (!MESSAGE_SUBTYPES.has(subtype) || isKyto(user, botId)) {
    return;
  }
  if (threadTs && threadTs !== ts) {
    await onThreadReply({ channel, threadTs });
  }
  const body = text.replace(/^\s*(?:<@[A-Z0-9]+>\s*)*/, '');
  if (body.startsWith('##') || /^!secret\b/i.test(body)) {
    return;
  }
  const author = user ?? botId ?? 'unknown';
  const matching = cache.filter((reminder) => {
    const trigger = reminder.trigger;
    return (
      trigger?.source === 'slack_message' &&
      trigger.channel === channel &&
      (!trigger.threadTs || trigger.threadTs === (threadTs ?? ts)) &&
      (!trigger.fromUser ||
        trigger.fromUser === user ||
        trigger.fromUser === botId) &&
      patternMatches({ pattern: trigger.pattern, regex: trigger.regex, text })
    );
  });
  if (matching.length === 0) {
    return;
  }
  // A person's words go into a model run only with their consent (the opt-in);
  // a bot's post is fair game.
  if (user && !botId && !(await isUserAllowed(user))) {
    return;
  }
  const link = await permalink(channel, ts);
  for (const reminder of matching) {
    if (!(await creatorMayWatch({ channel, reminder }))) {
      continue;
    }
    await fire({
      payload: `message from <@${author}> in <#${channel}> (${link}):\n${text}`,
      reminder,
      summary: `triggered by a message from <@${author}> in <#${channel}>: ${link}`,
    });
  }
}

/**
 * A message's text for a fire's payload: a person's words go into a model run
 * only with their consent (the opt-in), a bot's post is fair game, and a
 * `##` message is invisible to kyto.
 */
async function consentedText(message: {
  bot_id?: string;
  text?: string;
  user?: string;
}): Promise<string | undefined> {
  const text = message.text ?? '';
  if (!text || text.trimStart().startsWith('##')) {
    return;
  }
  if (message.user && !message.bot_id && !(await isUserAllowed(message.user))) {
    return;
  }
  return text;
}

const repliesSchema = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        bot_id: z.string().optional(),
        reply_count: z.number().optional(),
        text: z.string().optional(),
        user: z.string().optional(),
      })
    )
    .optional(),
});

/** A reply landed in a thread: has it reached a `slack_replies` count? */
async function onThreadReply({
  channel,
  threadTs,
}: {
  channel: string;
  threadTs: string;
}): Promise<void> {
  const matching = cache.filter((reminder) => {
    const trigger = reminder.trigger;
    return (
      trigger?.source === 'slack_replies' &&
      trigger.channel === channel &&
      (!trigger.threadTs || trigger.threadTs === threadTs)
    );
  });
  if (matching.length === 0) {
    return;
  }
  const parsed = repliesSchema.safeParse(
    await slack.webClient.conversations
      .replies({ channel, limit: 1, ts: threadTs })
      .catch(() => undefined)
  );
  const root = parsed.success ? parsed.data.messages?.[0] : undefined;
  const replies = root?.reply_count;
  if (!(root && replies)) {
    return;
  }
  const reached = matching.filter(
    (reminder) =>
      reminder.trigger?.source === 'slack_replies' &&
      replies >= reminder.trigger.minReplies
  );
  if (reached.length === 0) {
    return;
  }
  const link = await permalink(channel, threadTs);
  const text = await consentedText(root);
  for (const reminder of reached) {
    if (!(await creatorMayWatch({ channel, reminder }))) {
      continue;
    }
    await fire({
      onceKey: threadTs,
      payload: `the thread ${link} in <#${channel}> reached ${replies} replies${text ? `; its first message:\n${text}` : ''}`,
      reminder,
      summary: `triggered by a thread reaching ${replies} replies: ${link}`,
    });
  }
}

const reactionEventSchema = z.looseObject({
  item: z.looseObject({
    channel: z.string().optional(),
    ts: z.string().optional(),
    type: z.string().optional(),
  }),
  reaction: z.string(),
  user: z.string(),
});

// Skin tones arrive as `+1::skin-tone-2`; a trigger on `+1` means all of them.
const sameEmoji = (name: string, wanted: string) =>
  name === wanted || name.startsWith(`${wanted}::`);

/** How many reactions a message has: of `emoji` when given, else of all. */
export function reactionCount({
  emoji,
  reactions,
}: {
  emoji?: string;
  reactions: { count?: number; name?: string }[];
}): number {
  let total = 0;
  for (const reaction of reactions) {
    if (!emoji || sameEmoji(reaction.name ?? '', emoji)) {
      total += reaction.count ?? 0;
    }
  }
  return total;
}

const reactedMessageSchema = z.looseObject({
  message: z
    .looseObject({
      bot_id: z.string().optional(),
      reactions: z
        .array(
          z.looseObject({
            count: z.number().optional(),
            name: z.string().optional(),
          })
        )
        .optional(),
      text: z.string().optional(),
      thread_ts: z.string().optional(),
      ts: z.string().optional(),
      user: z.string().optional(),
    })
    .optional(),
});

/** A Slack `reaction_added` event. */
export async function onSlackReaction(rawEvent: unknown): Promise<void> {
  if (cache.length === 0) {
    return;
  }
  const parsed = reactionEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return;
  }
  const { item, reaction, user } = parsed.data;
  const { channel, ts } = item;
  if (item.type !== 'message' || !channel || !ts || isKyto(user, undefined)) {
    return;
  }
  const matching = cache.filter((reminder) => {
    const trigger = reminder.trigger;
    return (
      trigger?.source === 'slack_reaction' &&
      trigger.channel === channel &&
      (!trigger.emoji || sameEmoji(reaction, trigger.emoji)) &&
      (!trigger.fromUser || trigger.fromUser === user) &&
      (!trigger.messageTs || trigger.messageTs === ts)
    );
  });
  if (matching.length === 0) {
    return;
  }
  // A count or a thread needs the message itself: one read for every trigger.
  const needsMessage = matching.some(
    (reminder) =>
      reminder.trigger?.source === 'slack_reaction' &&
      (reminder.trigger.minReactions || reminder.trigger.threadTs)
  );
  const fetched = needsMessage
    ? reactedMessageSchema.safeParse(
        await slack.webClient.reactions
          .get({ channel, full: true, timestamp: ts })
          .catch(() => undefined)
      )
    : undefined;
  const message = fetched?.success ? fetched.data.message : undefined;
  const link = await permalink(channel, ts);
  for (const reminder of matching) {
    const trigger = reminder.trigger;
    if (trigger?.source !== 'slack_reaction') {
      continue;
    }
    if (
      trigger.threadTs &&
      trigger.threadTs !== (message?.thread_ts ?? message?.ts)
    ) {
      continue;
    }
    const count = trigger.minReactions
      ? reactionCount({
          emoji: trigger.emoji,
          reactions: message?.reactions ?? [],
        })
      : 0;
    if (trigger.minReactions && count < trigger.minReactions) {
      continue;
    }
    if (!(await creatorMayWatch({ channel, reminder }))) {
      continue;
    }
    if (!trigger.minReactions) {
      await fire({
        payload: `<@${user}> reacted :${reaction}: to ${link} in <#${channel}>`,
        reminder,
        summary: `triggered by <@${user}> reacting :${reaction}: to ${link}`,
      });
      continue;
    }
    const what = trigger.emoji ? `:${trigger.emoji}: reactions` : 'reactions';
    const text = message ? await consentedText(message) : undefined;
    await fire({
      onceKey: ts,
      payload: `${link} in <#${channel}> reached ${count} ${what} (latest :${reaction}: from <@${user}>)${text ? `; the message:\n${text}` : ''}`,
      reminder,
      summary: `triggered by a message reaching ${count} ${what}: ${link}`,
    });
  }
}

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const githubBodySchema = z.looseObject({
  action: z.string().optional(),
  repository: z.looseObject({ full_name: z.string().optional() }).optional(),
});

export function githubEventMatches({
  action,
  event,
  trigger,
}: {
  action: string | undefined;
  event: string;
  trigger: Extract<ReminderTrigger, { source: 'github' }>;
}): boolean {
  const wanted = trigger.events ?? [];
  return (
    wanted.length === 0 ||
    wanted.some((entry) => {
      const [name, wantedAction] = entry.split('.');
      return name === event && (!wantedAction || wantedAction === action);
    })
  );
}

const plain = (body: string, status: number) =>
  new Response(body, {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
    status,
  });

/**
 * `POST /_hooks/<reminder id>/<secret>` (a plain webhook) or
 * `POST /_hooks/<reminder id>` signed by GitHub with the reminder's secret.
 * Anything else is a 404, so the route says nothing about which ids exist.
 */
export async function handleReminderWebhook(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith(WEBHOOK_PREFIX)) {
    return null;
  }
  const notFound = plain('Not found', 404);
  if (request.method !== 'POST') {
    return notFound;
  }
  const [id = '', pathSecret] = pathname
    .slice(WEBHOOK_PREFIX.length)
    .split('/');
  const reminder = await getReminder(id).catch(() => null);
  const trigger = reminder?.trigger;
  if (
    !(reminder?.active && reminder.webhookSecret && trigger) ||
    (trigger.source !== 'webhook' && trigger.source !== 'github')
  ) {
    return notFound;
  }
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > WEBHOOK_BODY_MAX_BYTES) {
    return plain('Too large', 413);
  }
  const raw = await request.text();
  if (raw.length > WEBHOOK_BODY_MAX_BYTES) {
    return plain('Too large', 413);
  }

  if (trigger.source === 'webhook') {
    if (!(pathSecret && sameSecret(pathSecret, reminder.webhookSecret))) {
      return notFound;
    }
    fire({
      payload: `webhook body:\n${raw}`,
      reminder,
      summary: 'triggered by a call to its webhook',
    }).catch(() => undefined);
    return plain('Accepted', 202);
  }

  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const expected = `sha256=${createHmac('sha256', reminder.webhookSecret).update(raw).digest('hex')}`;
  if (!sameSecret(signature, expected)) {
    return plain('Bad signature', 401);
  }
  const event = request.headers.get('x-github-event') ?? '';
  // GitHub's hello when the webhook is added: answered, never fired.
  if (event === 'ping') {
    return plain('pong', 200);
  }
  let body: z.infer<typeof githubBodySchema> = {};
  try {
    body = githubBodySchema.parse(JSON.parse(raw));
  } catch {
    return plain('Not JSON', 400);
  }
  if (!githubEventMatches({ action: body.action, event, trigger })) {
    return plain('Ignored', 202);
  }
  const what = body.action ? `${event}.${body.action}` : event;
  const repo = body.repository?.full_name ?? 'a repository';
  fire({
    payload: `GitHub ${what} on ${repo}:\n${raw}`,
    reminder,
    summary: `triggered by GitHub: ${what} on ${repo}`,
  }).catch(() => undefined);
  return plain('Accepted', 202);
}
