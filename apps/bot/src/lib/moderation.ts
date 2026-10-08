import { createHash } from 'node:crypto';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { bot } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  flaggedItems,
  type ModerationItem,
  responseSchema,
} from '@/lib/moderation-flags';
import { toLogError } from '@/lib/utils/error';

// Hack Club's proxy of OpenAI's moderation API: free, not logged, 5000 calls per
// 30 min per key. Every input of a turn goes in ONE call (it takes an array),
// after the reply is out, so it costs the person nothing in latency.
const MODERATION_URL = 'https://ai.hackclub.com/proxy/v1/moderations';
const MODERATION_MODEL = 'omni-moderation-latest';
const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 10_000;
const MAX_INPUTS = 32;
// Custom instructions ride along on every turn of their author; one verdict
// per text is enough.
const checkedInstructions = new Set<string>();

const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
// Per thread + author: which categories the owner was already pinged about.
const recentAlerts = new Map<string, { at: number; categories: Set<string> }>();

/**
 * Check one finished turn and, if anything is flagged, add the owner to the
 * channel and ping him in the thread (a `!secret` turn: in his DM, no content). It never blocks, deletes
 * or bans — banning is the owner's, by hand (owner's call, 2026-10-02).
 */
export async function moderateTurn({
  asUserAccount,
  authorUserId,
  items,
  secret,
  thread,
}: {
  asUserAccount: boolean;
  authorUserId: string;
  items: ModerationItem[];
  secret: boolean;
  thread: Thread;
}): Promise<void> {
  const owner = env.OWNER_USER_ID;
  if (!(owner && env.HACKCLUB_API_KEY) || authorUserId === owner) {
    return;
  }
  const instructionHash = (text: string): string =>
    createHash('sha256').update(text).digest('hex');
  const inputs = items
    .filter(
      (item) =>
        item.text.trim() &&
        !(
          item.source === 'custom instructions' &&
          checkedInstructions.has(instructionHash(item.text))
        )
    )
    .slice(0, MAX_INPUTS)
    .map((item) => ({ ...item, text: item.text.slice(0, MAX_INPUT_CHARS) }));
  if (inputs.length === 0) {
    return;
  }
  try {
    const response = await fetch(MODERATION_URL, {
      body: JSON.stringify({
        input: inputs.map((item) => item.text),
        model: MODERATION_MODEL,
      }),
      headers: {
        Authorization: `Bearer ${env.HACKCLUB_API_KEY}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, '[moderation] check refused');
      return;
    }
    const parsed = responseSchema.parse(await response.json());
    // Marked checked only once a check actually came back: marked up front, a
    // failed request (or one cut by MAX_INPUTS) meant those instructions were
    // never checked at all.
    for (const item of items) {
      if (
        item.source === 'custom instructions' &&
        inputs.some((input) => input.source === item.source)
      ) {
        checkedInstructions.add(instructionHash(item.text));
      }
    }
    const flags = flaggedItems({ items: inputs, results: parsed.results });
    if (flags.length === 0) {
      return;
    }
    logger.warn(
      { authorUserId, flags, threadId: thread.id },
      '[moderation] turn flagged'
    );
    // The same person repeating the same ask got the owner pinged on every
    // repeat (issue #53). Within the window only a NEW category pings again.
    const alertKey = `${thread.id}:${authorUserId}`;
    const now = Date.now();
    for (const [key, entry] of recentAlerts) {
      if (now - entry.at > ALERT_COOLDOWN_MS) {
        recentAlerts.delete(key);
      }
    }
    const previous = recentAlerts.get(alertKey);
    const categories = flags.flatMap((flag) => flag.categories);
    if (previous && categories.every((name) => previous.categories.has(name))) {
      logger.info(
        { authorUserId, threadId: thread.id },
        '[moderation] repeat flag; owner already alerted'
      );
      return;
    }
    recentAlerts.set(alertKey, {
      at: now,
      categories: new Set([...(previous?.categories ?? []), ...categories]),
    });
    // Into the channel first, even one he left (owner's call, 2026-10-03): he
    // can't act on a flag in a channel he can't see, and a private channel's
    // ping doesn't notify a non-member. A DM or group DM can't take him.
    const client = asUserAccount
      ? thread.adapter.requireUserAccountClient()
      : thread.adapter.webClient;
    const { channel } = thread.adapter.decodeThreadId(thread.id);
    const info = await client.conversations
      .info({ channel })
      .catch(() => undefined);
    if (info?.channel && !(info.channel.is_im || info.channel.is_mpim)) {
      await client.conversations
        .invite({ channel, users: owner })
        .catch((error: unknown) => {
          if (!String(error).includes('already_in_channel')) {
            logger.warn(
              { ...toLogError(error), channel },
              '[moderation] adding the owner failed'
            );
          }
        });
    }
    const lines = flags.map(
      (flag) => `• ${flag.source}: ${flag.categories.join(', ')}`
    );
    const markdown = `<@${owner}> moderation flagged <@${authorUserId}>'s ${secret ? '`!secret` ' : ''}request to kyto:\n${lines.join('\n')}`;
    if (secret) {
      const dm = await bot.openDM(owner);
      await dm.post({ markdown });
      return;
    }
    await thread.post({
      ...(asUserAccount ? { fromUserAccount: true } : {}),
      markdown,
    });
  } catch (error) {
    logger.warn({ err: toLogError(error) }, '[moderation] check failed');
  }
}
