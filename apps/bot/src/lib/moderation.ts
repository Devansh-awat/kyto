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

/**
 * Check one finished turn and, if anything is flagged, ping the owner in the
 * thread (a `!secret` turn: in his DM, no content). It never blocks, deletes
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
  const inputs = items
    .filter((item) => {
      if (!item.text.trim()) {
        return false;
      }
      if (item.source !== 'custom instructions') {
        return true;
      }
      const hash = createHash('sha256').update(item.text).digest('hex');
      if (checkedInstructions.has(hash)) {
        return false;
      }
      checkedInstructions.add(hash);
      return true;
    })
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
    const flags = flaggedItems({ items: inputs, results: parsed.results });
    if (flags.length === 0) {
      return;
    }
    logger.warn(
      { authorUserId, flags, threadId: thread.id },
      '[moderation] turn flagged'
    );
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
