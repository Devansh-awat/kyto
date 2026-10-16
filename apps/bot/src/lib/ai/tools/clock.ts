import { tool } from 'ai';
import { z } from 'zod';

export function nowTool() {
  return tool({
    description:
      'The current date and time, live. The time at the end of your prompt was stamped when this turn started; use this after a long run of work or a wait, or to get the time in a particular timezone.',
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          'An IANA timezone, e.g. `Asia/Kolkata` or `America/New_York`. Omit for UTC only.'
        ),
    }),
    execute: ({ timezone }) => {
      const now = new Date();
      const result: Record<string, string | number> = {
        unix: Math.floor(now.getTime() / 1000),
        utc: now.toISOString(),
      };
      if (timezone) {
        try {
          result.local = now.toLocaleString('en-GB', {
            dateStyle: 'full',
            timeStyle: 'long',
            timeZone: timezone,
          });
        } catch {
          result.error = `Unknown timezone "${timezone}": use an IANA name like Europe/London.`;
        }
      }
      return Promise.resolve(result);
    },
  });
}
