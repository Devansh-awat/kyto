import { claimDueThreadWakes, createThreadWake } from '@repo/db/queries';
import type { Message } from '@/harness/types';
import { getTurn, USER_ACCOUNT_TURN_SUFFIX } from '@/lib/agent/turns';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// Fires the wakes kyto scheduled for itself (tools/wake.ts): a new turn in the
// thread, as whoever's turn scheduled it, carrying kyto's note.

const POLL_MS = 30_000;
// A thread busy with a turn when its wake comes due is retried this much later
// rather than interrupting it.
const BUSY_RETRY_MS = 60_000;

type RunTurn = (input: {
  asUserAccount: boolean;
  message: Message;
  thread: ReturnType<typeof bot.thread>;
}) => Promise<void>;

async function pollOnce(runTurn: RunTurn): Promise<void> {
  const due = await claimDueThreadWakes(new Date());
  for (const wake of due) {
    const slot = wake.asUserAccount
      ? `${wake.threadId}${USER_ACCOUNT_TURN_SUFFIX}`
      : wake.threadId;
    if (getTurn({ threadId: slot })) {
      await createThreadWake({
        asUserAccount: wake.asUserAccount,
        chain: wake.chain,
        note: wake.note,
        threadId: wake.threadId,
        userId: wake.userId,
        wakeAt: new Date(Date.now() + BUSY_RETRY_MS),
      });
      continue;
    }
    const author = await slack.getUser(wake.userId);
    const message: Message = {
      attachments: [],
      author,
      id: `thread-wake-${wake.chain}-${wake.id}`,
      isMention: false,
      metadata: { dateSent: new Date() },
      raw: {},
      text: `[Automatic note, not written by a person: at ${wake.createdAt.toISOString()} you scheduled this wake to come back to this thread and pick up the following. Do it now, finishing it in this turn; if what it waited on is still not back, say so, and schedule another wake only if it is worth one. Don't explain that you were woken. If nothing needs doing any more, call the skip TOOL. Do not write the word "skip" as your reply.\n\nYour note: ${wake.note}]`,
      threadId: wake.threadId,
    };
    logger.info(
      { chain: wake.chain, threadId: wake.threadId, wakeId: wake.id },
      '[wakes] waking the thread'
    );
    runTurn({
      asUserAccount: wake.asUserAccount,
      message,
      thread: bot.thread(wake.threadId),
    }).catch((error: unknown) => {
      logger.warn(
        { err: errorMessage(error), threadId: wake.threadId },
        '[wakes] wake turn failed'
      );
    });
  }
}

export function startThreadWakes(runTurn: RunTurn): void {
  const tick = (): void => {
    pollOnce(runTurn).catch((error: unknown) => {
      logger.error({ err: errorMessage(error) }, '[wakes] poll failed');
    });
  };
  setInterval(tick, POLL_MS);
  tick();
}
