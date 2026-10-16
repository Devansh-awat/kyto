import type { Message } from '@/harness/types';
import { withoutFlags } from '@/lib/flags';
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

// How long a folded-in message may wait for a tool result to ride on. A turn
// that is streaming its answer, or sitting in one long tool, gets interrupted
// after this as before.
const STEER_DELIVERY_MS = 30_000;

/**
 * Fold a message into the running turn instead of aborting it: it is handed to
 * the model with the next tool result (`takeSteering`), so a correction three
 * minutes into research no longer throws that research away. False when it
 * can't be folded in, and the caller interrupts as before.
 *
 * Only the turn's OWN author's messages: every gate in the turn checks that
 * author, so anyone else's words folded in would act with their identity (the
 * reason `queuedInput` stops at the author boundary). Not a message carrying
 * files either: only a turn's own message gets them put in the sandbox. And
 * only a real Slack message: a background or subagent wake carries the
 * author's id and tells kyto to skip if nothing needs saying, which mid-turn
 * would end the turn it was folded into.
 */
export function steerTurn({
  activeTurn,
  input,
}: {
  activeTurn: ActiveTurn;
  input: TurnInput;
}): boolean {
  const author = activeTurn.message?.author.userId;
  if (
    !author ||
    input.message.author.userId !== author ||
    input.message.attachments.length > 0 ||
    typeof input.message.raw.ts !== 'string'
  ) {
    return false;
  }
  activeTurn.steering.push(input);
  setTimeout(() => {
    const index = activeTurn.steering.indexOf(input);
    if (index !== -1 && !activeTurn.controller.signal.aborted) {
      activeTurn.steering.splice(index, 1);
      interruptTurn({ activeTurn, input });
    }
  }, STEER_DELIVERY_MS).unref();
  return true;
}

/** The waiting follow-ups as one note for a tool result, and off the queue. */
export function takeSteering(activeTurn: ActiveTurn): string | undefined {
  const waiting = activeTurn.steering.splice(0);
  const notes = waiting
    .map(({ message }) => withoutFlags(message.text).trim())
    .filter(Boolean)
    .map(
      (text) =>
        `[New message from the person you're working for, sent while you were working on this. Read it and factor it in now; your final reply answers it too]: ${text}`
    );
  return notes.length > 0 ? notes.join('\n\n') : undefined;
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
    .map(({ message }) => withoutFlags(message.text).trim())
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
