import { TurnAbort } from '@/lib/agent/steering';
import {
  hasThreadProcesses,
  killThreadProcesses,
} from '@/lib/ai/tools/background';
import logger from '@/lib/logger';
import type { ActiveTurn } from '@/types/agent';

const turns = new Map<string, ActiveTurn>();

export function getTurn({
  threadId,
}: {
  threadId: string;
}): ActiveTurn | undefined {
  return turns.get(threadId);
}

export function setTurn({
  threadId,
  turn,
}: {
  threadId: string;
  turn: ActiveTurn;
}): void {
  turns.set(threadId, turn);
}

export function clearTurn({
  threadId,
  turn,
}: {
  threadId: string;
  turn: ActiveTurn;
}): void {
  if (turns.get(threadId) === turn) {
    turns.delete(threadId);
  }
}

// The user account's turn in a thread has its own slot beside the app's.
export const USER_ACCOUNT_TURN_SUFFIX = '#user';

/**
 * Stop whatever is running in the thread — the app's turn and the account's —
 * or only the ones `mayStop` allows.
 */
export function stopTurn({
  mayStop,
  source,
  threadId,
  userId,
}: {
  mayStop?: (turn: ActiveTurn) => boolean;
  /** Which caller is stopping: logged, so an `interrupted` turn can be traced. */
  source: string;
  threadId: string;
  userId?: string;
}): boolean {
  let stopped = false;
  for (const slot of [threadId, `${threadId}${USER_ACCOUNT_TURN_SUFFIX}`]) {
    const turn = turns.get(slot);
    if (turn && (!mayStop || mayStop(turn))) {
      logger.info(
        {
          source,
          threadId,
          turnAnswering: turn.message?.id,
          turnSlot: slot,
          userId,
        },
        '[agent] stopping turn'
      );
      turn.controller.abort(new TurnAbort('stop'));
      stopped = true;
    }
  }
  // A stop covers the detached sandbox jobs too, or "Stopped" is a lie: they
  // run on, and their reports keep waking the thread. With no turn running
  // that is still a stop (the jobs outlive their turn), and the caller must
  // not answer "nothing to stop". A caller filtering turns (`mayStop`) only
  // stops jobs along with a turn it let through.
  const jobs = hasThreadProcesses(threadId);
  if (stopped || (!mayStop && jobs)) {
    stopped = true;
    killThreadProcesses(threadId)
      .then((killed) => {
        if (killed > 0) {
          logger.info(
            { killed, source, threadId },
            '[agent] killed background jobs on stop'
          );
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            threadId,
          },
          '[agent] failed to kill background jobs on stop'
        );
      });
  }
  return stopped;
}

const SETTLE_POLL_MS = 100;

/**
 * Abort every turn, then wait (bounded) for them to leave the map. Exiting
 * straight after the abort cut off their `finally` blocks: sandboxes were left
 * running at E2B instead of paused, and partial replies never flushed.
 */
export async function stopAllTurns({
  settleMs,
}: {
  settleMs: number;
}): Promise<void> {
  for (const turn of turns.values()) {
    turn.controller.abort(new TurnAbort('shutdown'));
  }
  const deadline = Date.now() + settleMs;
  while (turns.size > 0 && Date.now() < deadline) {
    await Bun.sleep(SETTLE_POLL_MS);
  }
}
