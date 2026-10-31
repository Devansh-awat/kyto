import { createHash, randomUUID } from 'node:crypto';
import {
  claimOrphanedTurns,
  finishInflightTurn,
  heartbeatInflightTurn,
  type InflightCheckpoint,
  type InflightEffect,
  markInstanceInterrupted,
  pruneInflightTurns,
  setInflightCheckpoint,
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
    lastCheckpointAt.delete(threadId);
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

function hashInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? '';
  } catch {
    text = String(input);
  }
  return createHash('sha256').update(text).digest('hex');
}

// Asking again for the same picture or speech is a fair "another one".
const REPEATABLE_EFFECTS = new Set(['generateImage', 'textToSpeech', 'wait']);

/**
 * The turn's LAST outward action, done, with the same tool and the SAME input
 * (before a restart included). A resumed turn wrote one canvas three times
 * over, each in an identical back-to-back pair (#123): the ledger only TOLD
 * the model, and a model that loses track repeats itself. Only the last one,
 * so pin → unpin → pin still works.
 */
export function repeatedEffect({
  input,
  threadId,
  tool,
}: {
  input: unknown;
  threadId: string;
  tool: string;
}): InflightEffect | undefined {
  if (REPEATABLE_EFFECTS.has(tool)) {
    return;
  }
  const last = effectsByThread
    .get(threadId)
    ?.findLast((effect) => effect.tool !== 'wait');
  return last?.tool === tool &&
    last.status === 'done' &&
    last.inputHash === hashInput(input)
    ? last
    : undefined;
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
    inputHash: hashInput(input),
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

/**
 * A `wait` the restart cut short (#77): "wait 5 minutes, then grade" was
 * re-run from the top after a deploy, the elapsed time forgotten. Its start
 * and length are in the ledger, so the resumed turn is told when it was due
 * to end and to wait out only what is left.
 */
function describeCutWait(effect: InflightEffect, now: Date): string {
  const seconds = Number(/"seconds":(\d+)/.exec(effect.input)?.[1] ?? 0);
  const dueAt = new Date(Date.parse(effect.at) + seconds * 1000);
  const left = Math.ceil((dueAt.getTime() - now.getTime()) / 1000);
  return left > 0
    ? `- You were in the middle of a ${seconds}s wait (started ${effect.at}, due to end ${dueAt.toISOString()}) when kyto restarted. It is now ${now.toISOString()}: call wait for the ${left}s still left, then carry on with what the wait was for. Don't restart the wait from the beginning.`
    : `- You were in the middle of a ${seconds}s wait (started ${effect.at}) when kyto restarted, and it has already run its course (it was due to end ${dueAt.toISOString()}; it is now ${now.toISOString()}). Don't wait again — carry on with what the wait was for.`;
}

/** For a resumed turn: what the cut turn did, told plainly. */
export function describePriorEffects(
  effects: InflightEffect[],
  now: Date = new Date()
): string {
  const cutWaits = effects
    .filter((effect) => effect.tool === 'wait' && effect.status === 'started')
    .map((effect) => describeCutWait(effect, now));
  const outward = effects.filter((effect) => effect.tool !== 'wait');
  const waits = cutWaits.length > 0 ? `\n${cutWaits.join('\n')}` : '';
  if (outward.length === 0) {
    return `Before the restart this turn had taken no outward action (no post, DM, email, deploy or reminder), so nothing will be repeated by doing the work.${waits}`;
  }
  const lines = outward.map((effect) => {
    const state = EFFECT_STATE[effect.status];
    const result = effect.result ? ` → ${effect.result}` : '';
    return `- ${effect.tool}(${effect.input}) at ${effect.at}: ${state}${result}`;
  });
  return `Outward actions this turn took before the restart:\n${lines.join('\n')}${waits}`;
}

// A checkpoint is rewritten whole, so at most once a minute — and when a
// shutdown cuts the turn, which is the write that matters most.
const CHECKPOINT_EVERY_MS = 60 * 1000;
// One result as big as a whole channel directory is fine; a runaway one is
// cut, and the resumed request is compacted past 100k tokens like a fallback.
const CHECKPOINT_OUTPUT_MAX = 60_000;
const lastCheckpointAt = new Map<string, number>();

// Postgres jsonb rejects a NUL (\u0000) and chokes on lone UTF-16 surrogates,
// so a tool result carrying binary (a fetchUrl of a raw PDF, #144) failed the
// whole checkpoint write and the turn lost its restart safety net. Strip those
// before they reach the column — a checkpoint is a best-effort snapshot, not the
// reply, so a scrubbed byte here costs nothing.
function scrubForJsonb(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what jsonb rejects.
  return text.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function boundedOutput(output: unknown): unknown {
  const raw =
    typeof output === 'string' ? output : (JSON.stringify(output) ?? '');
  const text =
    raw.length > CHECKPOINT_OUTPUT_MAX
      ? `${raw.slice(0, CHECKPOINT_OUTPUT_MAX)}… [cut at ${CHECKPOINT_OUTPUT_MAX} characters when kyto restarted]`
      : raw;
  const scrubbed = scrubForJsonb(text);
  // If nothing needed scrubbing and it fit, keep the original shape (objects
  // stay objects for the resumed turn); only fall back to the string when we
  // actually changed something.
  return scrubbed === raw ? output : scrubbed;
}

/**
 * Save where the turn has got to (owner's ask 2026-10-19: a restart must not
 * cost the work). Before this a crash lost everything and a deploy kept only
 * a text digest with each result cut to 6000 characters, so the resumed turn
 * re-listed thousands of channels it had already listed. Best-effort.
 */
export async function checkpointTurn({
  force = false,
  results,
  text,
  threadId,
}: {
  force?: boolean;
  results: InflightCheckpoint['results'];
  text: string;
  threadId: string;
}): Promise<void> {
  const now = Date.now();
  if (
    !force &&
    now - (lastCheckpointAt.get(threadId) ?? 0) < CHECKPOINT_EVERY_MS
  ) {
    return;
  }
  lastCheckpointAt.set(threadId, now);
  await setInflightCheckpoint({
    checkpoint: {
      at: new Date(now).toISOString(),
      results: results.map((result) => ({
        input: result.input,
        output: boundedOutput(result.output),
        toolName: result.toolName,
      })),
      text,
    },
    instanceId: INSTANCE_ID,
    threadId,
  }).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), threadId },
      '[inflight] checkpoint failed'
    );
  });
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
    priorCheckpoint?: InflightCheckpoint;
    priorEffects: InflightEffect[];
    resumed: boolean;
    thread: ReturnType<KytoBot['thread']>;
  }) => Promise<void>;
}): Promise<void> {
  const now = Date.now();
  const window = {
    instanceId: INSTANCE_ID,
    staleBefore: new Date(now - STALE_AFTER_MS),
    aliveAfter: new Date(now - RESUME_WINDOW_MS),
  };
  const claimed = await claimOrphanedTurns(window).catch((error: unknown) => {
    logger.warn(toLogError(error), '[inflight] claim failed');
    return [];
  });
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
    // No "restarted mid-reply" note (owner's ask 2026-10-19): the turn
    // carries on from its checkpoint as if nothing happened.
    runTurn({
      asUserAccount: row.asUserAccount,
      message,
      ...(row.checkpoint ? { priorCheckpoint: row.checkpoint } : {}),
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
