import type { Message } from '@/harness';
import type { AbortReason, ActiveTurn, TurnInput } from '@/types/agent';

export class TurnAbort extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason) {
    super(`turn aborted: ${reason}`);
    this.name = 'TurnAbort';
    this.reason = reason;
  }
}

export function abortReasonOf(signal: AbortSignal): AbortReason | undefined {
  if (!signal.aborted) {
    return;
  }
  const { reason } = signal;
  return reason instanceof TurnAbort ? reason.reason : 'interrupt';
}

export function interruptTurn({
  activeTurn,
  input,
}: {
  activeTurn: ActiveTurn;
  input: TurnInput;
}): void {
  activeTurn.pendingMessages.push(input);
  activeTurn.controller.abort(new TurnAbort('interrupt'));
}

/**
 * The follow-up input after an interrupt: a rapid burst merged into one message
 * so steering keeps every intermediate correction.
 *
 * **Only the trailing run by the SAME author is merged.** A thread is shared —
 * anyone subscribed to it can interrupt a running turn — so the queue can hold
 * messages from several people, and the merge used to take the LAST message's
 * identity and everyone's TEXT. That attributed one person's words to another,
 * and when the last sender happened to be the owner it ran a stranger's
 * instructions at owner privilege: `isOwner` is recomputed from
 * `message.author.userId`, which would be the owner's.
 *
 * Nothing is lost by stopping at the author boundary. Every queued message is a
 * real message in the thread, so `buildPrompt` replays it as history under its
 * own name — kyto still sees what the other people said, correctly attributed,
 * instead of as one impersonated block.
 */
export function queuedInput(activeTurn: ActiveTurn): TurnInput | undefined {
  const latest = activeTurn.pendingMessages.at(-1);
  if (!latest) {
    return;
  }
  const run: TurnInput[] = [];
  for (let index = activeTurn.pendingMessages.length - 1; index >= 0; index--) {
    const candidate = activeTurn.pendingMessages[index];
    if (candidate?.message.author.userId !== latest.message.author.userId) {
      break;
    }
    run.unshift(candidate);
  }
  if (run.length === 1) {
    return latest;
  }

  const text = run
    .map(({ message }) => message.text.trim())
    .filter(Boolean)
    .join('\n\n');

  const merged: Message = {
    ...latest.message,
    raw: {
      combinedFrom: run.map(({ message }) => ({
        id: message.id,
        text: message.text,
      })),
    },
    text,
  };
  return { message: merged, thread: latest.thread };
}
