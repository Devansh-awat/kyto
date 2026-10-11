import { randomUUID } from 'node:crypto';
import {
  claimAbandonedTurns,
  claimOrphanedTurns,
  finishInflightTurn,
  heartbeatInflightTurn,
  type InflightEffect,
  markInstanceInterrupted,
  pruneInflightTurns,
  setInflightEffects,
  startInflightTurn,
} from '@repo/db/queries';
import type { KytoBot } from '@/harness/bot';
import type { Message } from '@/harness/types';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecrets } from '@/lib/redact';
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
// Silent for longer than this (counted from the last heartbeat, so a long
// OpenCode turn still qualifies), the conversation has moved on and a resumed
// answer would be noise. Also what the table is pruned to.
const RESUME_WINDOW_MS = 30 * 60 * 1000;
// Clean shutdowns a turn survives. More than one, because deploys land in
// bursts; bounded, because a turn can itself restart kyto (the Coolify MCP),
// and resuming that forever would be a restart loop. 3 was too few: five
// pushes in eight minutes (2026-10-08) restarted kyto four times and dropped
// an owner's OpenCode turn with "won't pick this up on its own".
const MAX_RESTART_RESUMES = 8;
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
  asUserAccount,
  message,
  priorEffects = [],
  resumed,
  threadId,
}: {
  asUserAccount: boolean;
  message: Message;
  /** A resumed turn's record from before the restart; it keeps growing. */
  priorEffects?: InflightEffect[];
  resumed: boolean;
  threadId: string;
}): (options: { cutByShutdown: boolean }) => Promise<void> {
  const ids = { instanceId: INSTANCE_ID, threadId };
  effectsByThread.set(threadId, resumed ? [...priorEffects] : []);
  startInflightTurn({
    ...ids,
    asUserAccount,
    messageId: message.id,
    resumed,
    userId: message.author.userId,
  }).catch((error: unknown) => {
    logger.warn({ ...toLogError(error), threadId }, '[inflight] start failed');
  });
  const beat = setInterval(() => {
    heartbeatInflightTurn(ids).catch(() => undefined);
  }, HEARTBEAT_MS);
  return async ({ cutByShutdown }) => {
    clearInterval(beat);
    effectsByThread.delete(threadId);
    // Only a turn the shutdown actually CUT stays resumable. One that finished
    // on its own inside the shutdown window keeps no row — left `interrupted`,
    // the next instance answered it a second time.
    if (shuttingDown && cutByShutdown) {
      return;
    }
    await finishInflightTurn(ids).catch(() => undefined);
  };
}

// Outward actions of each running turn, mirrored into its inflight row.
const effectsByThread = new Map<string, InflightEffect[]>();
const MAX_EFFECTS = 40;
const EFFECT_INPUT_MAX = 240;
// Room for a canvas/site/message link and its id: a canvas created just before
// a restart was marked DONE with no link, so the resumed turn and every turn
// after it said "the save didn't return one".
const EFFECT_RESULT_MAX = 400;

function compact(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    text = String(value);
  }
  return redactSecrets(
    text.length > max ? `${text.slice(0, max)}…` : text,
    'inflight effect'
  );
}

/**
 * Record an outward action BEFORE it runs, and return the call that marks it
 * done or failed. A restart between the two leaves it `started`: the resumed
 * turn is told it may or may not have happened, instead of finding out by
 * posting the same message twice. Best-effort; never in the tool's way.
 */
export function startEffect({
  input,
  threadId,
  tool,
}: {
  input: unknown;
  threadId: string;
  tool: string;
}): (status: 'done' | 'failed', result?: unknown) => void {
  const effects = effectsByThread.get(threadId) ?? [];
  const effect: InflightEffect = {
    at: new Date().toISOString(),
    input: compact(input, EFFECT_INPUT_MAX),
    status: 'started',
    tool,
  };
  const next = [...effects, effect].slice(-MAX_EFFECTS);
  effectsByThread.set(threadId, next);
  const save = () =>
    setInflightEffects({
      effects: effectsByThread.get(threadId) ?? [],
      instanceId: INSTANCE_ID,
      threadId,
    }).catch(() => undefined);
  // Awaited by nobody, but issued now: the point is to be on disk before the
  // action itself, and the action's own network call takes longer than this.
  save();
  return (status, result) => {
    effect.status = status;
    if (result !== undefined) {
      effect.result = compact(result, EFFECT_RESULT_MAX);
    }
    save();
  };
}

const EFFECT_STATE: Record<InflightEffect['status'], string> = {
  done: 'DONE — do not do it again',
  failed: 'failed',
  started:
    'STARTED, result UNKNOWN — the restart cut it before or after it happened; check (read the thread, the channel, the inbox, the site) before doing it again',
};

/** For a resumed turn: what the cut turn did, told plainly. */
export function describePriorEffects(effects: InflightEffect[]): string {
  if (effects.length === 0) {
    return 'Before the restart this turn had taken no outward action (no post, DM, email, deploy or reminder), so nothing will be repeated by doing the work.';
  }
  const lines = effects.map((effect) => {
    const state = EFFECT_STATE[effect.status];
    const result = effect.result ? ` → ${effect.result}` : '';
    return `- ${effect.tool}(${effect.input}) at ${effect.at}: ${state}${result}`;
  });
  return `Outward actions this turn took before the restart:\n${lines.join('\n')}`;
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
  asUserAccount,
  messageId,
  threadId,
}: {
  asUserAccount: boolean;
  messageId: string;
  threadId: string;
}): Promise<Message | null> {
  const { channel, threadTs } = slack.decodeThreadId(threadId);
  // The user account's turns are often in its DMs, which the app can't read.
  const client = asUserAccount
    ? slack.requireUserAccountClient()
    : slack.webClient;
  const result = await client.conversations
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
    asUserAccount: boolean;
    message: Message;
    priorEffects: InflightEffect[];
    resumed: boolean;
    thread: ReturnType<KytoBot['thread']>;
  }) => Promise<void>;
}): Promise<void> {
  const now = Date.now();
  const window = {
    instanceId: INSTANCE_ID,
    maxRestartResumes: MAX_RESTART_RESUMES,
    staleBefore: new Date(now - STALE_AFTER_MS),
    aliveAfter: new Date(now - RESUME_WINDOW_MS),
  };
  const claimed = await claimOrphanedTurns(window).catch((error: unknown) => {
    logger.warn(toLogError(error), '[inflight] claim failed');
    return [];
  });
  const abandoned = await claimAbandonedTurns(window).catch(
    (error: unknown) => {
      logger.warn(toLogError(error), '[inflight] abandon failed');
      return [];
    }
  );
  // Out of resumes: the turn ends here, and the thread is told so — it used
  // to just stop, mid-plan, with nothing after it.
  for (const row of abandoned) {
    logger.warn(
      { resumes: row.resumes, status: row.status, threadId: row.threadId },
      '[inflight] not resuming again; telling the thread'
    );
    if (!row.asUserAccount) {
      await bot
        .thread(row.threadId)
        .post({
          markdown:
            "_kyto restarted mid-reply again and won't pick this up on its own — ping it to carry on._",
        })
        .catch(() => undefined);
    }
  }
  for (const row of claimed) {
    // A throw here (a users.info lookup failing while the message is rebuilt)
    // would strand this row and every one after it: claimed, never run.
    const message = await refetchMessage(row).catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), threadId: row.threadId },
        '[inflight] could not rebuild the interrupted message'
      );
      return null;
    });
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
    // The user account talks like a person, and a person doesn't announce
    // that they restarted.
    if (!row.asUserAccount) {
      await thread
        .post({
          markdown: '_kyto restarted mid-reply — picking this back up._',
        })
        .catch(() => undefined);
    }
    runTurn({
      asUserAccount: row.asUserAccount,
      message,
      priorEffects: row.effects,
      resumed: true,
      thread,
    }).catch((error: unknown) => {
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
    resumeOnce({ bot, runTurn })
      .catch((error: unknown) => {
        logger.warn(toLogError(error), '[inflight] resume pass failed');
      })
      .finally(() => {
        if (Date.now() - started < POLL_FOR_MS) {
          setTimeout(tick, POLL_EVERY_MS);
        }
      });
  };
  tick();
}
