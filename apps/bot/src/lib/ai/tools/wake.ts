import {
  cancelThreadWake,
  createThreadWake,
  listThreadWakes,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// The id of the synthetic message a wake turn runs on (lib/agent/wakes.ts),
// with how many wakes in a row led to it.
const THREAD_WAKE_ID = /^thread-wake-(\d+)-/;
const MAX_WAKE_MINUTES = 7 * 24 * 60;
// A thread with more than this many queued is kyto scheduling instead of doing.
const MAX_PENDING = 5;
// Each wake turn may schedule the next one; past this, something is looping.
const MAX_WAKE_CHAIN = 10;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

// "in 6 hours", "in 45 minutes", "in 2 days", read in the thread.
function inWords(minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (minutes < 2 * MINUTES_PER_DAY) {
    const hours = Math.round((minutes / MINUTES_PER_HOUR) * 2) / 2;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${Math.round(minutes / MINUTES_PER_DAY)} days`;
}

export function wakeTool({
  asUserAccount,
  authorUserId,
  messageId,
  thread,
}: {
  asUserAccount: boolean;
  authorUserId: string;
  messageId: string;
  thread: ThreadHandle;
}) {
  const threadId = thread.id;
  return tool({
    description: `Come back to THIS thread later, in a new turn of your own. Nothing runs after your turn ends, so this is how "I'll do it once X is back" actually happens: at the time you pick you get a turn here, as the person who asked, carrying your note.

Use it when the work is blocked on something that changes by itself: a model route or rate limit that resets (its error says when), a deploy, build or long job finishing, a time the person named. Never end a turn on "say retry" or "I'll do it later" without one. Don't use it to poll something that will tell you by itself, and for a pause under an hour where you'd rather keep this turn going, use \`wait\` instead.

Picking \`minutes\`: match it to what you're waiting for.
- A known recovery time (a limit that resets at 00:00 UTC, "cooling down until 14:59"): just after it.
- A job or deploy of known length: about that long, once. One well-timed wake beats several short checks.
- Blocked with no time given (an outage, a quota with no reset): 30 to 60 minutes, and say it's a guess.

\`note\` is for you: exactly what to pick up, enough to do it cold (the commands, paths, how to check it worked). \`reason\` is for the person: one short lowercase line on what you're waiting for. It is posted in the thread with the time, so they see that you scheduled it and when you'll be back; don't repeat it in your reply.

To see this thread's pending wakes use listWakes; to cancel one, cancelWake.`,
    inputSchema: z.object({
      minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAKE_MINUTES)
        .describe('How many minutes from now to wake up.'),
      note: z
        .string()
        .min(1)
        .max(4000)
        .describe(
          'What to pick up, in enough detail to do it cold (exact commands, paths, how to verify).'
        ),
      reason: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'One short lowercase line for the person on what you are waiting for (posted with the time).'
        ),
    }),
    execute: async ({ minutes, note, reason }) => {
      try {
        const chain = Number(messageId.match(THREAD_WAKE_ID)?.[1] ?? 0);
        if (chain >= MAX_WAKE_CHAIN) {
          return {
            error: `This turn is the ${chain}th wake in a row here; no more. Finish now, or say plainly what is left and that it won't happen on its own.`,
            success: false,
          };
        }
        const pending = await listThreadWakes(threadId);
        if (pending.length >= MAX_PENDING) {
          return {
            error: `This thread already has ${pending.length} wakes queued (list them); cancel one or fold this into it.`,
            success: false,
          };
        }
        const wake = await createThreadWake({
          asUserAccount,
          chain: chain + 1,
          note,
          threadId,
          userId: authorUserId,
          wakeAt: new Date(Date.now() + minutes * 60_000),
        });
        // Said by kyto itself, not left to the model: a wake nobody hears
        // about reads as kyto going quiet. Lowercase, italic, no em dash,
        // with the time in each reader's own timezone.
        const unix = Math.floor(wake.wakeAt.getTime() / 1000);
        const iso = `${wake.wakeAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        const why = reason.trim().replace(/[—–]/g, ',').replace(/\.$/, '');
        await thread
          .post({
            fromUserAccount: asUserAccount,
            markdown: `_scheduled a wake: back here in ${inWords(minutes)} (<!date^${unix}^{date_short_pretty} at {time}|${iso}>), ${why.charAt(0).toLowerCase()}${why.slice(1)}_`,
          })
          .catch((error: unknown) => {
            logger.warn(
              { err: errorMessage(error), threadId },
              '[wakes] could not post the wake notice'
            );
          });
        return {
          id: wake.id,
          success: true,
          summary: `Wake scheduled for ${wake.wakeAt.toISOString()} (in ${inWords(minutes)}); the thread was told when you'll be back. Don't repeat it.`,
          wakeAt: wake.wakeAt.toISOString(),
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/** This thread's pending wakes. */
export function listWakesTool({ thread }: { thread: ThreadHandle }) {
  return tool({
    description:
      "List this thread's pending wakes (id, note, who scheduled it, when). Use it before cancelWake.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const wakes = await listThreadWakes(thread.id);
        return {
          success: true,
          wakes: wakes.map((wake) => ({
            id: wake.id,
            note: wake.note,
            scheduledBy: wake.userId,
            wakeAt: wake.wakeAt.toISOString(),
          })),
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}

/** Cancel a pending wake: its scheduler or the owner. */
export function cancelWakeTool({
  authorUserId,
  isOwner,
  thread,
}: {
  authorUserId: string;
  isOwner: boolean;
  thread: ThreadHandle;
}) {
  const threadId = thread.id;
  return tool({
    description:
      'Cancel a pending wake of this thread by id (from listWakes). Only the person whose turn scheduled it, or the owner.',
    inputSchema: z.object({
      id: z.string().min(1).describe('The wake to cancel.'),
    }),
    execute: async ({ id }) => {
      try {
        const pending = await listThreadWakes(threadId);
        const target = pending.find((wake) => wake.id === id);
        if (!target) {
          return { error: `No pending wake ${id} here.`, success: false };
        }
        if (!isOwner && target.userId !== authorUserId) {
          return {
            error: `Only <@${target.userId}>, whose turn scheduled it, or the owner can cancel that wake.`,
            success: false,
          };
        }
        await cancelThreadWake({ id, threadId });
        return { success: true, summary: 'Wake cancelled.' };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
