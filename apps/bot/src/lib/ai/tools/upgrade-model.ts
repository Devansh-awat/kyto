import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';

// "This is beyond me — get a better model."
//
// Owner's call, 2026-08-05: the model may escalate itself whenever it judges a
// task complex, anyone may trigger it, and how often it happens is LOGGED so the
// prompt can be tuned if it escalates too much or too little.
//
// The escalation rungs are expensive (kimi-k3 is ~20x the primary's input price
// and ~50x its output price) and the whole tier shares one $3/day cap, so a
// single long escalated turn can eat most of a day. Two bounds, both here:
// ONCE per turn, and a workspace-wide daily count. Neither is a judgement about
// whether the task deserved it — they exist so a bad judgement, or a prompt
// injection asking for one, costs a bounded amount.

// Workspace-wide escalations per UTC day. Sized so a genuinely hard day still
// works while a loop cannot drain the cap: ~8 escalated turns is already a large
// share of $3 at kimi-k3 prices.
const DAILY_LIMIT = 8;

let day = '';
let used = 0;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** How many escalations are left today. Resets at UTC midnight. */
function claimDailyBudget(): boolean {
  const now = today();
  if (now !== day) {
    day = now;
    used = 0;
  }
  if (used >= DAILY_LIMIT) {
    return false;
  }
  used += 1;
  return true;
}

export interface Escalation {
  /** Set when the model asked for a stronger one and the turn hasn't moved yet. */
  pending?: { reason: string };
  /** True once this turn has escalated; a turn only gets one. */
  used?: boolean;
}

export function upgradeModelTool({
  escalation,
  threadId,
  userId,
}: {
  escalation: Escalation;
  threadId: string;
  userId: string;
}) {
  return tool({
    description:
      "Hand this turn over to a stronger, more expensive model. Use it when the task is genuinely hard for you — intricate multi-file code, a subtle bug, tricky maths or reasoning, a long plan with many dependencies — or when you have tried and your answer would be a guess. Everything you have already found is passed on, so nothing is wasted and you should NOT redo the work first. Don't reach for it on ordinary questions, chat, or a task you can already do: it costs many times more per token and comes out of one shared daily budget for everyone. Once per turn.",
    inputSchema: z.object({
      reason: z
        .string()
        .min(3)
        .max(300)
        .describe(
          'What specifically is hard about this — one line, for the log and for the model taking over.'
        ),
    }),
    execute: ({ reason }) => {
      if (escalation.used) {
        return Promise.resolve({
          upgraded: false,
          // Said plainly so the model gets on with it rather than trying again.
          summary:
            'This turn has already been upgraded — you ARE the stronger model. Carry on and answer with what you have.',
        });
      }
      if (!claimDailyBudget()) {
        logger.warn(
          { reason, threadId, userId },
          '[agent] model upgrade refused: daily escalation budget spent'
        );
        return Promise.resolve({
          upgraded: false,
          summary: `The daily budget for upgrading to a stronger model (${DAILY_LIMIT} per day, shared by everyone) is spent. Carry on with this task yourself and do the best you can; say so plainly if part of the answer is uncertain.`,
        });
      }
      escalation.pending = { reason };
      logger.info(
        { reason, threadId, usedToday: used, userId },
        '[agent] model upgrade requested'
      );
      return Promise.resolve({
        upgraded: true,
        summary:
          'Handing this turn to a stronger model now, with everything you found so far. Stop here.',
      });
    },
  });
}
