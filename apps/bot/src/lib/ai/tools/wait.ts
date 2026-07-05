import { tool } from 'ai';
import { z } from 'zod';

// A mid-turn pause: the model calls this to be "alerted back" after a delay
// (e.g. to space out a sequence of checks, or wait out a short external
// process) instead of ending the turn. Capped well under ATTEMPT_TIMEOUT_MS
// (agent/index.ts, default 10 minutes) so a wait can never itself cause the
// attempt watchdog to fire.
const MAX_WAIT_SECONDS = 240;

export function waitTool() {
  return tool({
    description:
      'Pause for a short duration, then continue the turn. Use to space out steps or wait out a brief external delay. Capped at 4 minutes; for anything longer, use scheduleReminder instead.',
    inputSchema: z.object({
      seconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_SECONDS)
        .describe(`How long to wait, in seconds (max ${MAX_WAIT_SECONDS}).`),
    }),
    execute: async ({ seconds }) => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return { waitedSeconds: seconds };
    },
  });
}
