import {
  clearThreadRevisions,
  getThreadSubscription,
  listThreadRevisions,
  type MessageRevision,
  pruneMessageRevisions,
  recordMessageRevision,
} from '@repo/db/queries';
import { z } from 'zod';
import { isUserAllowed } from '@/lib/allowed-users';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecrets } from '@/lib/redact';
import { errorMessage } from '@/lib/utils/error';

// What a message said before an edit, and what a deleted one said (owner's ask,
// 2026-10-11): without it "do X", an edit to "do Y", then "you did it wrong"
// was unanswerable, and a deleted instruction vanished from kyto's view.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT_CHARS = 4000;

// Token shapes a person might paste by mistake and then delete. Their own
// secrets aren't known to kyto the way its env is (lib/redact.ts), so the
// shape is the only handle; a deleted password stays deleted from here.
// cspell:disable
const TOKEN_SHAPES = [
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
// cspell:enable

const ADDRESSED_ONLY = /^(?:<>|&lt;&gt;)/;
const LEADING_MENTIONS = /^\s*(?:<@[A-Z0-9][A-Z0-9._-]*(?:\|[^>]+)?>\s*)+/;

const innerSchema = z.looseObject({
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string().optional(),
  user: z.string().optional(),
});
const eventSchema = z.looseObject({
  channel: z.string().optional(),
  message: innerSchema.optional(),
  previous_message: innerSchema.optional(),
  subtype: z.string().optional(),
});

// Deletions kyto itself is about to make on someone's behalf (the owner's
// "Delete message" shortcut): that shortcut exists to take a message out of
// kyto's context, so its deletion must not be written back in here.
const deletingOnPurpose = new Set<string>();
const recentlySeen = new Set<string>();

/** Call before deleting a message that kyto must then forget, not remember. */
export function forgetDeletionOf({
  channel,
  ts,
}: {
  channel: string;
  ts: string;
}): void {
  const key = `${channel}:${ts}`;
  deletingOnPurpose.add(key);
  setTimeout(() => deletingOnPurpose.delete(key), 60_000).unref();
}

/**
 * Is this earlier text something kyto may keep? Not a `##` message (hidden
 * from kyto from the start), not a `<>` one that didn't ping kyto (it was
 * never addressed to kyto), and never a `!secret` question, which kyto deletes
 * itself and whose text must not be stored anywhere.
 */
export function keepable({
  kytoIds,
  text,
}: {
  kytoIds: string[];
  text: string;
}): boolean {
  const body = text.replace(LEADING_MENTIONS, '').trimStart();
  if (body.startsWith('##') || /^!secret\b/i.test(body)) {
    return false;
  }
  const raw = text.trimStart();
  if (ADDRESSED_ONLY.test(raw) || ADDRESSED_ONLY.test(body)) {
    return kytoIds.some((id) => text.includes(`<@${id}>`));
  }
  return true;
}

function scrub(text: string): string {
  let out = redactSecrets(text, 'message revision');
  for (const shape of TOKEN_SHAPES) {
    out = out.replace(shape, '[redacted token]');
  }
  return out.length > MAX_TEXT_CHARS
    ? `${out.slice(0, MAX_TEXT_CHARS)}… [cut]`
    : out;
}

/** Only threads kyto is part of: a DM, a code channel, or one it follows. */
async function kytoIsIn({
  channel,
  rootTs,
}: {
  channel: string;
  rootTs: string;
}): Promise<boolean> {
  if (channel.startsWith('D') || slack.isChannelConversation(channel)) {
    return true;
  }
  const threadId = slack.encodeThreadId({ channel, threadTs: rootTs });
  return (await getThreadSubscription(threadId)) !== null;
}

/**
 * Keep the before-text of an edit, or the text of a deletion, from a Slack
 * `message` event. Human messages only — kyto's own streamed replies and other
 * bots' status posts are edited constantly and say nothing about what anyone
 * asked.
 */
export async function recordRevision(rawEvent: unknown): Promise<void> {
  const parsed = eventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return;
  }
  const { channel, message, previous_message: previous, subtype } = parsed.data;
  if (
    !(channel && previous?.ts && previous.user && previous.text) ||
    (subtype !== 'message_changed' && subtype !== 'message_deleted') ||
    previous.bot_id ||
    previous.user === slack.botUserId ||
    previous.user === slack.userAccountId
  ) {
    return;
  }
  // An unfurl or a file added arrives as an edit with the same text.
  if (subtype === 'message_changed' && message?.text === previous.text) {
    return;
  }
  if (
    subtype === 'message_deleted' &&
    deletingOnPurpose.has(`${channel}:${previous.ts}`)
  ) {
    return;
  }
  const kytoIds = [slack.botUserId, slack.userAccountId].filter(
    (id): id is string => Boolean(id)
  );
  if (!keepable({ kytoIds, text: previous.text })) {
    return;
  }
  // The app and the user account's connection can both deliver one event.
  const seenKey = `${channel}:${previous.ts}:${subtype}:${previous.text}`;
  if (recentlySeen.has(seenKey)) {
    return;
  }
  recentlySeen.add(seenKey);
  setTimeout(() => recentlySeen.delete(seenKey), 10 * 60_000).unref();
  const rootTs = previous.thread_ts ?? previous.ts;
  try {
    // Stored message text needs its author's consent (Hack Club's scraping
    // policy; docs/reference/security.md): the opt-in is that consent.
    if (
      !(
        (await isUserAllowed(previous.user)) &&
        (await kytoIsIn({ channel, rootTs }))
      )
    ) {
      return;
    }
    await recordMessageRevision({
      channel,
      kind: subtype === 'message_deleted' ? 'deleted' : 'edited',
      messageTs: previous.ts,
      rootTs,
      text: scrub(previous.text),
      userId: previous.user,
    });
  } catch (error) {
    logger.warn(
      { channel, err: errorMessage(error), ts: previous.ts },
      '[revisions] could not record an edit or deletion'
    );
  }
}

/** A thread's earlier versions and deletions, keyed by message ts. */
export async function threadRevisions(
  threadId: string
): Promise<Map<string, MessageRevision[]>> {
  const { channel, threadTs } = slack.decodeThreadId(threadId);
  const byMessage = new Map<string, MessageRevision[]>();
  const rows = await listThreadRevisions({
    channel,
    since: new Date(Date.now() - RETENTION_MS),
    ...(threadTs ? { rootTs: threadTs } : {}),
  }).catch((error: unknown) => {
    logger.warn(
      { err: errorMessage(error), threadId },
      "[revisions] could not read a thread's edits"
    );
    return [];
  });
  for (const row of rows) {
    byMessage.set(row.messageTs, [
      ...(byMessage.get(row.messageTs) ?? []),
      row,
    ]);
  }
  return byMessage;
}

/** The thread clean-up's reset. */
export async function forgetThreadRevisions(threadId: string): Promise<void> {
  const { channel, threadTs } = slack.decodeThreadId(threadId);
  if (threadTs) {
    await clearThreadRevisions({ channel, rootTs: threadTs });
  }
}

export function startRevisionReaper(): void {
  const prune = () =>
    pruneMessageRevisions(new Date(Date.now() - RETENTION_MS)).catch(
      (error: unknown) => {
        logger.warn({ err: errorMessage(error) }, '[revisions] prune failed');
      }
    );
  prune();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
}
