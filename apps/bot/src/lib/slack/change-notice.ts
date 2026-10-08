import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

// How far back the system message can be: it was posted by the call that just
// returned, so a few seconds is plenty and anything older is someone else's.
const LOOKBACK_SECONDS = 60;

const historySchema = z.looseObject({
  messages: z
    .array(z.looseObject({ subtype: z.string().optional(), ts: z.string() }))
    .optional(),
});

/**
 * Say who asked for a channel change kyto just made.
 *
 * Slack credits the change to kyto ("kyto set the channel topic"), so the
 * channel can't tell who actually wanted it, and a member who disliked the
 * change had nobody to ask. The note goes in the THREAD of Slack's own system
 * message, never as a new top-level post: a non-owner's action must not start
 * one (GATING.md). Best effort; a missing note never fails the change.
 */
export async function creditChange({
  channel,
  requesterId,
  subtype,
}: {
  channel: string;
  requesterId: string;
  subtype: 'channel_purpose' | 'channel_topic' | 'pinned_item';
}): Promise<void> {
  try {
    const history = historySchema.parse(
      await slack.webClient.conversations.history({
        channel,
        limit: 10,
        oldest: String(Date.now() / 1000 - LOOKBACK_SECONDS),
      })
    );
    const notice = history.messages?.find(
      (message) => message.subtype === subtype
    );
    if (!notice) {
      return;
    }
    await slack.webClient.chat.postMessage({
      channel,
      text: `Changed at <@${requesterId}>'s request.`,
      thread_ts: notice.ts,
    });
  } catch (error) {
    logger.warn(
      { channel, err: errorMessage(error), subtype },
      '[change-notice] could not credit the change'
    );
  }
}
