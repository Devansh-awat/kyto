import { randomUUID } from 'node:crypto';
import {
  claimOrphanedTurns,
  finishInflightTurn,
  heartbeatInflightTurn,
  markInstanceInterrupted,
  pruneInflightTurns,
  startInflightTurn,
} from '@repo/db/queries';
import type { KytoBot, Message } from '@/harness';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// Picking a turn back up after a restart (owner's ask, 2026-09-29, after seeing
// coolton do it). Every Coolify redeploy used to kill whatever kyto was halfway
// through answering, and nobody was told.
//
// The rows live in `inflight_turns` (see its schema for the protocol). The part
// that needs care is a ROLLING deploy: the new container boots while the old one
// is still finishing turns, so a turn is only taken over once the old instance
// has either said it is shutting down (`interrupted`) or stopped heartbeating
// (a crash) — and it is claimed atomically, so it runs exactly once.

/** This process. A new one per boot, so "whose row is it" is unambiguous. */
const INSTANCE_ID = randomUUID();

const HEARTBEAT_MS = 30_000;
// Four missed heartbeats: that instance is gone, not just busy.
const STALE_AFTER_MS = 2 * 60 * 1000;
// Older than this, the conversation has moved on and a resumed answer would be
// noise. Also what the table is pruned to.
const RESUME_WINDOW_MS = 30 * 60 * 1000;
// A new instance keeps looking for a while, because the old one only marks its
// turns interrupted when IT is told to stop — after this one is already up.
const POLL_EVERY_MS = 15_000;
const POLL_FOR_MS = 10 * 60 * 1000;

let shuttingDown = false;

/**
 * Record a turn as running here, keep its heartbeat going, and return the call
 * that ends it. A turn cut short by shutdown is left behind for the next
 * instance; every other ending deletes it. Best-effort throughout: tracking a
 * turn must never be why it fails.
 */
export function trackTurn({
  message,
  resumed,
  threadId,
}: {
  message: Message;
  resumed: boolean;
  threadId: string;
}): () => Promise<void> {
  const ids = { instanceId: INSTANCE_ID, threadId };
  startInflightTurn({
    ...ids,
    messageId: message.id,
    resumed,
    userId: message.author.userId,
  }).catch((error: unknown) => {
    logger.warn({ ...toLogError(error), threadId }, '[inflight] start failed');
  });
  const beat = setInterval(() => {
    heartbeatInflightTurn(ids).catch(() => undefined);
  }, HEARTBEAT_MS);
  return async () => {
    clearInterval(beat);
    if (shuttingDown) {
      return;
    }
    await finishInflightTurn(ids).catch(() => undefined);
  };
}

/** Called first thing on SIGTERM: everything running here becomes resumable. */
export async function markShuttingDown(): Promise<void> {
  shuttingDown = true;
  await markInstanceInterrupted(INSTANCE_ID).catch((error: unknown) => {
    logger.warn(toLogError(error), '[inflight] could not mark turns resumable');
  });
}

/**
 * The message a turn was answering, rebuilt from Slack. Null if it is gone
 * (deleted, or the channel is no longer readable) — then there is nothing to
 * resume.
 */
async function refetchMessage({
  messageId,
  threadId,
}: {
  messageId: string;
  threadId: string;
}): Promise<Message | null> {
  const { channel, threadTs } = slack.decodeThreadId(threadId);
  const result = await slack.webClient.conversations
    .replies({
      channel,
      inclusive: true,
      latest: messageId,
      limit: 2,
      oldest: messageId,
      ts: threadTs || messageId,
    })
    .catch(() => null);
  const raw = result?.messages?.find((entry) => entry.ts === messageId);
  if (!raw?.user) {
    return null;
  }
  const author = await slack.getUser(raw.user);
  return slack.buildMessage({ ...raw, channel } as never, author);
}

async function resumeOnce({
  bot,
  runTurn,
}: {
  bot: KytoBot;
  runTurn: (input: {
    message: Message;
    resumed: boolean;
    thread: ReturnType<KytoBot['thread']>;
  }) => Promise<void>;
}): Promise<void> {
  const now = Date.now();
  const claimed = await claimOrphanedTurns({
    instanceId: INSTANCE_ID,
    staleBefore: new Date(now - STALE_AFTER_MS),
    startedAfter: new Date(now - RESUME_WINDOW_MS),
  }).catch((error: unknown) => {
    logger.warn(toLogError(error), '[inflight] claim failed');
    return [];
  });
  for (const row of claimed) {
    const message = await refetchMessage(row);
    const thread = bot.thread(row.threadId);
    if (!message) {
      logger.info(
        { threadId: row.threadId },
        '[inflight] interrupted turn’s message is gone; not resuming'
      );
      await finishInflightTurn({
        instanceId: INSTANCE_ID,
        threadId: row.threadId,
      }).catch(() => undefined);
      continue;
    }
    logger.info(
      { messageId: row.messageId, threadId: row.threadId },
      '[inflight] resuming a turn interrupted by a restart'
    );
    await thread
      .post({ markdown: '_kyto restarted mid-reply — picking this back up._' })
      .catch(() => undefined);
    runTurn({ message, resumed: true, thread }).catch((error: unknown) => {
      logger.error(
        { ...toLogError(error), threadId: row.threadId },
        '[inflight] resumed turn failed'
      );
    });
  }
}

/**
 * Look for turns another instance left behind, now and for the next few
 * minutes (see POLL_FOR_MS for why not just once).
 */
export function startResumingOrphanedTurns({
  bot,
  runTurn,
}: Parameters<typeof resumeOnce>[0]): void {
  pruneInflightTurns(new Date(Date.now() - RESUME_WINDOW_MS)).catch(
    () => undefined
  );
  const started = Date.now();
  const tick = () => {
    if (shuttingDown) {
      return;
    }
    resumeOnce({ bot, runTurn }).finally(() => {
      if (Date.now() - started < POLL_FOR_MS) {
        setTimeout(tick, POLL_EVERY_MS);
      }
    });
  };
  tick();
}
