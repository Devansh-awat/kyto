import {
  cancelThreadWake,
  createThreadWake,
  listThreadWakes,
} from '@repo/db/queries';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// The id of the synthetic message a wake turn runs on (lib/agent/wakes.ts),
// with how many wakes in a row led to it.
const THREAD_WAKE_ID = /^thread-wake-(\d+)-/;
const MAX_WAKE_MINUTES = 7 * 24 * 60;
// A thread with more than this many queued is kyto scheduling instead of doing.
const MAX_PENDING = 5;
// Each wake turn may schedule the next one; past this, something is looping.
const MAX_WAKE_CHAIN = 10;

export function wakeTool({
  asUserAccount,
  authorUserId,
  isOwner,
  messageId,
  threadId,
}: {
  asUserAccount: boolean;
  authorUserId: string;
  isOwner: boolean;
  messageId: string;
  threadId: string;
}) {
  return tool({
    description: `Come back to THIS thread later, in a new turn of your own. Nothing runs after your turn ends, so this is how "I'll do it once X is back" actually happens: schedule a wake for when it can run (a model route's recovery time, a deploy or a job finishing, a time the person named), with a note of exactly what to pick up (the command, the files, how to check it worked). At that time you get a turn here as the person who asked, with the note. For a delay under an hour where you'd rather keep the turn going, use \`wait\` instead. Tell the person when you'll be back. Actions: schedule (minutes from now, 1 to ${MAX_WAKE_MINUTES}, plus note), list (this thread's pending wakes), cancel (by id; its scheduler or the owner).`,
    inputSchema: z.object({
      action: z.enum(['schedule', 'list', 'cancel']),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAKE_MINUTES)
        .optional()
        .describe('schedule: how many minutes from now to wake up.'),
      note: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe(
          'schedule: what to pick up, in enough detail to do it cold (exact commands, paths, how to verify).'
        ),
      id: z.string().optional().describe('cancel: the wake to cancel.'),
    }),
    execute: async ({ action, id, minutes, note }) => {
      try {
        if (action === 'list') {
          const wakes = await listThreadWakes(threadId);
          return {
            success: true,
            wakes: wakes.map((wake) => ({
              id: wake.id,
              note: wake.note,
              scheduledBy: wake.userId,
              wakeAt: wake.wakeAt.toISOString(),
            })),
          };
        }
        if (action === 'cancel') {
          if (!id) {
            return { error: 'cancel needs the wake id.', success: false };
          }
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
        }
        if (!(minutes && note)) {
          return {
            error: 'schedule needs minutes and a note.',
            success: false,
          };
        }
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
        return {
          id: wake.id,
          success: true,
          summary: `I'll be back in this thread at ${wake.wakeAt.toISOString()} with that note.`,
          wakeAt: wake.wakeAt.toISOString(),
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
