import { tool } from 'ai';
import { z } from 'zod';
import logger from '@/lib/logger';

export function nowTool({
  askerTimezone,
}: {
  /** The asker's Slack profile timezone, looked up only when it is needed. */
  askerTimezone: () => Promise<string | undefined>;
}) {
  return tool({
    description:
      "The current date and time, live: UTC plus the asker's own timezone from their Slack profile (or the timezone you name). The time at the end of your prompt was stamped when this turn started; use this after a long run of work or a wait, or for the time somewhere in particular.",
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "An IANA timezone, e.g. `Asia/Kolkata` or `America/New_York`. Omit for the asker's own."
        ),
    }),
    execute: async ({ timezone }) => {
      const now = new Date();
      const result: Record<string, string | number> = {
        unix: Math.floor(now.getTime() / 1000),
        utc: now.toISOString(),
      };
      const zone =
        timezone ??
        (await askerTimezone().catch((error: unknown) => {
          logger.warn({ err: error }, '[now] asker timezone lookup failed');
          return;
        }));
      if (!zone) {
        result.note =
          "The asker's Slack profile has no timezone; only UTC is known.";
        return result;
      }
      try {
        result.timezone = zone;
        result.local = now.toLocaleString('en-GB', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: zone,
        });
      } catch {
        result.error = `Unknown timezone "${zone}": use an IANA name like Europe/London.`;
      }
      return result;
    },
  });
}
