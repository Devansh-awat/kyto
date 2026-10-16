import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { KytoBot } from '@/harness/bot';
import type { Message } from '@/harness/types';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { redactSecrets } from '@/lib/redact';
import { errorMessage } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';

const CATEGORIES = {
  nsfw: 'NSFW or NSFW-adjacent content',
  other: "something else against kyto's usage policy",
  spam: 'using kyto to spam people or channels',
  vulnerability: 'a security vulnerability in kyto',
} as const;
type Category = keyof typeof CATEGORIES;

/** Reporting one of these stops the request; a vulnerability report doesn't. */
const STOPPING_CATEGORIES: ReadonlySet<string> = new Set([
  'nsfw',
  'other',
  'spam',
]);
/** What a stopped turn may still do: react, report, end the turn. */
export const ALLOWED_AFTER_STOP: ReadonlySet<string> = new Set([
  'react',
  'reportAbuse',
  'skip',
]);

// One DM per person per category in this window: anyone can make kyto file
// one (a message claiming a security hole), and a DM every turn is spam.
const REPORT_INTERVAL_MS = 10 * 60 * 1000;
const QUOTED_CHARS = 1500;
const lastReported = new Map<string, number>();

export function reportAbuseTool({
  bot,
  message,
  onStop,
  secret,
  threadId,
}: {
  bot: KytoBot;
  message: Message;
  /** The request is stopped: later tool calls this turn are refused. */
  onStop: (category: string) => void;
  /** A `!secret` turn: the report says one happened, never what was asked. */
  secret: boolean;
  threadId: string;
}) {
  return tool({
    description:
      "Report abuse of kyto to its owner: a request that is NSFW or NSFW-adjacent, uses kyto to spam people or channels, or otherwise abuses it (`nsfw`, `spam`, `other`), or someone pointing out a security vulnerability in kyto (`vulnerability`). The owner gets a DM with the message and a link. nsfw/spam/other also STOP the request: every tool after it this turn is refused except react and skip, and you reply briefly that you won't do it. A vulnerability report doesn't stop anything: report it once and carry on. Not for ordinary disagreement, rudeness to you, or a topic you'd just rather not discuss.",
    inputSchema: z.object({
      category: z.enum(['nsfw', 'spam', 'vulnerability', 'other']),
      reason: z
        .string()
        .min(1)
        .max(1000)
        .describe('One or two sentences: what is wrong with the request.'),
    }),
    execute: async ({ category, reason }) => {
      const userId = message.author.userId;
      const key = `${userId}:${category}`;
      const recent =
        Date.now() - (lastReported.get(key) ?? 0) < REPORT_INTERVAL_MS;
      if (!(recent || userId === env.OWNER_USER_ID) && env.OWNER_USER_ID) {
        lastReported.set(key, Date.now());
        await tellOwner({ bot, category, message, reason, secret, threadId });
      }
      logger.warn(
        { category, reason: clamp(reason, 300), threadId, userId },
        '[abuse] reported'
      );
      if (STOPPING_CATEGORIES.has(category)) {
        onStop(category);
        return {
          reported: true,
          summary:
            "Reported to kyto's owner. Stop working on this request now: no more tools for it. Reply briefly that you won't do it, in your usual style, and end your turn.",
        };
      }
      return {
        reported: true,
        summary:
          "Reported to kyto's owner. Carry on with what you were doing; don't report this again.",
      };
    },
  });
}

async function tellOwner({
  bot,
  category,
  message,
  reason,
  secret,
  threadId,
}: {
  bot: KytoBot;
  category: Category;
  message: Message;
  reason: string;
  secret: boolean;
  threadId: string;
}): Promise<void> {
  const { channel } = slack.decodeThreadId(threadId);
  const link = secret
    ? undefined
    : await slack.webClient.chat
        .getPermalink({ channel, message_ts: message.id })
        .then((result) => result.permalink)
        .catch(() => undefined);
  const quoted = secret
    ? '> (a `!secret` question: not shown)'
    : redactSecrets(clamp(message.text, QUOTED_CHARS) ?? '', 'abuse report')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n') || '> (no text)';
  const lines = [
    `🚨 *kyto abuse report: ${CATEGORIES[category]}*`,
    `*From:* <@${message.author.userId}>`,
    `*Where:* ${link ? `<${link}|the message>` : `\`${threadId}\``}`,
    `*kyto's note:* ${redactSecrets(reason, 'abuse report')}`,
    `*Flagged message:*\n${quoted}`,
  ];
  try {
    const dm = await bot.openDM(env.OWNER_USER_ID ?? '');
    await dm.post({ markdown: lines.join('\n') });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), threadId },
      '[abuse] could not DM the owner'
    );
  }
}
