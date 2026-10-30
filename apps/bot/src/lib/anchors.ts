import {
  deleteChannelAnchor,
  getNpsSurvey,
  listChannelAnchors,
  listNpsResponses,
  moveChannelAnchor,
  setChannelAnchor,
  setNpsSurveyMessageTs,
} from '@repo/db/queries';
import type { ChannelAnchor } from '@repo/db/schema';
import { z } from 'zod';
import { env } from '@/env';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { buildNpsBlocks, isNpsClosed } from '@/lib/slack/nps';
import { refreshNpsCard } from '@/lib/slack/nps-card';
import {
  buildPollBlocks,
  buildPollMetadata,
  parsePollStateFromRaw,
  postSlackMessage,
} from '@/lib/slack/poll';
import { toLogError } from '@/lib/utils/error';

// A poll or NPS card kept at the bottom of a channel, like a pinned notice
// that doesn't scroll away: every new top-level message reposts it under that
// message (delete + post + pin). Reposts in one channel run one at a time, and
// a burst of messages within REPOST_DEBOUNCE_MS reposts once, after the last.

const CHANNEL_MANAGER_ROLE = 'Rl0A';
const REPOST_DEBOUNCE_MS = 1500;
const ROLE_TIMEOUT_MS = 5000;

const roleAssignmentsSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
  role_assignments: z
    .array(z.object({ role_id: z.string(), users: z.array(z.string()) }))
    .optional(),
});

/**
 * May this person anchor (or un-anchor) a card here? The owner, or one of the
 * channel's Slack Channel Managers. Slack exposes that list only through the
 * client's own `admin.roles.entity.listAssignments`, which the bot token can't
 * call, so it is read with kyto's user-account session — read-only, one
 * channel's managers, never surfaced to the model. Fails closed.
 */
export async function canAnchor({
  channelId,
  userId,
}: {
  channelId: string;
  userId: string;
}): Promise<boolean> {
  if (env.OWNER_USER_ID && userId === env.OWNER_USER_ID) {
    return true;
  }
  const token = env.KYTO_USER_TOKEN;
  const cookie = env.KYTO_USER_COOKIE;
  if (!(token && cookie)) {
    return false;
  }
  const body = new FormData();
  body.set('token', token);
  body.set('entity_id', channelId);
  body.set('role_ids', CHANNEL_MANAGER_ROLE);
  try {
    const response = await fetch(
      'https://slack.com/api/admin.roles.entity.listAssignments',
      {
        body,
        headers: { Cookie: cookie.includes('=') ? cookie : `d=${cookie}` },
        method: 'POST',
        signal: AbortSignal.timeout(ROLE_TIMEOUT_MS),
      }
    );
    const parsed = roleAssignmentsSchema.safeParse(
      await response.json().catch(() => null)
    );
    if (!(parsed.success && parsed.data.ok)) {
      logger.warn(
        { channelId, error: parsed.success ? parsed.data.error : 'invalid' },
        '[anchors] could not read channel managers'
      );
      return false;
    }
    return (parsed.data.role_assignments ?? []).some(
      (role) =>
        role.role_id === CHANNEL_MANAGER_ROLE && role.users.includes(userId)
    );
  } catch (error) {
    logger.warn(
      { ...toLogError(error), channelId },
      '[anchors] could not read channel managers'
    );
    return false;
  }
}

// Every anchor, by channel: consulted on EVERY message event, so not a query.
let anchors: Promise<Map<string, ChannelAnchor>> | undefined;
const chains = new Map<string, Promise<unknown>>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function loadAnchors(): Promise<Map<string, ChannelAnchor>> {
  anchors ??= listChannelAnchors()
    .then((rows) => new Map(rows.map((row) => [row.channelId, row])))
    .catch((error: unknown) => {
      anchors = undefined;
      throw error;
    });
  return anchors;
}

/** Run `task` after every earlier task for this channel has finished. */
function inChannel<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(channelId) ?? Promise.resolve()).then(task, task);
  chains.set(
    channelId,
    run.catch(() => undefined)
  );
  return run;
}

async function unpin({
  channelId,
  ts,
}: {
  channelId: string;
  ts: string;
}): Promise<void> {
  await slack.webClient.pins
    .remove({ channel: channelId, timestamp: ts })
    .catch(() => undefined);
}

export async function getAnchor(
  channelId: string
): Promise<ChannelAnchor | undefined> {
  return (await loadAnchors()).get(channelId);
}

/**
 * Make an already-posted top-level card the channel's anchor, replacing any
 * earlier one (which stays where it is, unpinned and no longer moved).
 */
export async function anchorCard(row: {
  channelId: string;
  createdBy: string;
  kind: 'poll' | 'nps';
  messageTs: string;
  surveyId: number | null;
}): Promise<void> {
  await inChannel(row.channelId, async () => {
    const map = await loadAnchors();
    const previous = map.get(row.channelId);
    await setChannelAnchor(row);
    map.set(row.channelId, { ...row, createdAt: new Date() });
    if (previous && previous.messageTs !== row.messageTs) {
      await unpin({ channelId: row.channelId, ts: previous.messageTs });
    }
    await slack.webClient.pins
      .add({ channel: row.channelId, timestamp: row.messageTs })
      .catch((error: unknown) => {
        logger.warn(
          { ...toLogError(error), channelId: row.channelId },
          '[anchors] could not pin the card'
        );
      });
  });
}

/** Stop anchoring. The card stays where it is, unpinned. */
export async function removeAnchor(
  channelId: string
): Promise<ChannelAnchor | undefined> {
  return await inChannel(channelId, async () => {
    const map = await loadAnchors();
    const anchor = map.get(channelId);
    if (!anchor) {
      return;
    }
    await deleteChannelAnchor(channelId);
    map.delete(channelId);
    await unpin({ channelId, ts: anchor.messageTs });
    return anchor;
  });
}

const historySchema = z.looseObject({
  messages: z.array(z.looseObject({ ts: z.string() })).optional(),
});

async function repost(channelId: string): Promise<void> {
  const map = await loadAnchors();
  const anchor = map.get(channelId);
  if (!anchor) {
    return;
  }
  let posted: string;
  if (anchor.kind === 'nps') {
    const survey = anchor.surveyId
      ? await getNpsSurvey(anchor.surveyId)
      : undefined;
    // A closed survey has nothing left to collect: show the result where it
    // is and stop moving it.
    if (!survey || isNpsClosed(survey)) {
      if (survey) {
        await refreshNpsCard(survey);
      }
      await deleteChannelAnchor(channelId);
      map.delete(channelId);
      await unpin({ channelId, ts: anchor.messageTs });
      return;
    }
    posted = await postSlackMessage({
      blocks: buildNpsBlocks({
        responses: await listNpsResponses(survey.id),
        survey,
      }),
      channel: channelId,
      text: `Survey: ${survey.question}`,
    });
    await setNpsSurveyMessageTs({ id: survey.id, messageTs: posted });
  } else {
    // The votes live in the card's metadata, so read them off the card.
    const history = historySchema.parse(
      await slack.webClient.conversations.history({
        channel: channelId,
        include_all_metadata: true,
        inclusive: true,
        latest: anchor.messageTs,
        limit: 1,
      })
    );
    const message = history.messages?.find(
      (candidate) => candidate.ts === anchor.messageTs
    );
    const state = message ? parsePollStateFromRaw({ message }) : undefined;
    if (!state) {
      // Deleted by hand, most likely: nothing to move any more.
      await deleteChannelAnchor(channelId);
      map.delete(channelId);
      return;
    }
    posted = await postSlackMessage({
      blocks: buildPollBlocks(state),
      channel: channelId,
      metadata: buildPollMetadata(state),
      text: `Poll: ${state.question}`,
    });
  }
  if (
    !(await moveChannelAnchor({
      channelId,
      fromTs: anchor.messageTs,
      toTs: posted,
    }))
  ) {
    // Replaced or removed meanwhile: the new post is a stray copy.
    await slack.webClient.chat
      .delete({ channel: channelId, ts: posted })
      .catch(() => undefined);
    return;
  }
  map.set(channelId, { ...anchor, messageTs: posted });
  await slack.webClient.chat
    .delete({ channel: channelId, ts: anchor.messageTs })
    .catch(() => undefined);
  await slack.webClient.pins
    .add({ channel: channelId, timestamp: posted })
    .catch(() => undefined);
}

const messageEventSchema = z.looseObject({
  bot_id: z.string().optional(),
  channel: z.string(),
  subtype: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string(),
  user: z.string().optional(),
});
// A new message in the channel itself; an edit, a deletion or a thread reply
// doesn't push the card up.
const NEW_MESSAGE_SUBTYPES = new Set([
  undefined,
  'bot_message',
  'file_share',
  'me_message',
  'thread_broadcast',
  'channel_join',
]);

/** Every message event: a newer top-level message moves the anchor under it. */
export function onAnchorMessage(rawEvent: unknown): void {
  const parsed = messageEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    return;
  }
  const { bot_id: botId, channel, subtype, thread_ts, ts, user } = parsed.data;
  if (
    !NEW_MESSAGE_SUBTYPES.has(subtype) ||
    (thread_ts && thread_ts !== ts && subtype !== 'thread_broadcast') ||
    // Its own reposts would chase each other.
    (botId !== undefined && botId === slack.botId) ||
    (user !== undefined && user === slack.botUserId)
  ) {
    return;
  }
  loadAnchors()
    .then((map) => {
      const anchor = map.get(channel);
      if (!anchor || Number(ts) <= Number(anchor.messageTs)) {
        return;
      }
      clearTimeout(pending.get(channel));
      const timer = setTimeout(() => {
        pending.delete(channel);
        inChannel(channel, () => repost(channel)).catch((error: unknown) => {
          logger.warn(
            { ...toLogError(error), channelId: channel },
            '[anchors] repost failed'
          );
        });
      }, REPOST_DEBOUNCE_MS);
      timer.unref?.();
      pending.set(channel, timer);
    })
    .catch((error: unknown) => {
      logger.warn({ ...toLogError(error) }, '[anchors] could not load');
    });
}
