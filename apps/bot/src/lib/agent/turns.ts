import { TurnAbort } from '@/lib/agent/steering';
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

/** Stop whatever is running in the thread — the app's turn and the account's. */
export function stopTurn({ threadId }: { threadId: string }): boolean {
  let stopped = false;
  for (const slot of [threadId, `${threadId}${USER_ACCOUNT_TURN_SUFFIX}`]) {
    const turn = turns.get(slot);
    if (turn) {
      turn.controller.abort(new TurnAbort('stop'));
      stopped = true;
    }
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
