import { env } from '@/env';
import type { ActionEvent } from '@/harness';
import { executePostMessage } from '@/lib/ai/tools/post-message';
import {
  executeEditAsUser,
  executeSendAsUser,
} from '@/lib/ai/tools/send-as-user';
import { bot } from '@/lib/chat';
import { takePendingPost } from '@/lib/confirm-post/pending';
import {
  CONFIRM_CANCEL_ACTION,
  CONFIRM_SEND_ACTION,
  respondToInteraction,
} from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import { errorMessage, toLogError } from '@/lib/utils/error';

// Only the owner may confirm. The ephemeral is only shown to the owner, but a
// crafted interaction payload could still target the action id, so re-check the
// clicker here — this button is the last line of defense against a prompt
// injection driving an outward-facing post.
function isOwner(event: ActionEvent): boolean {
  return Boolean(env.OWNER_USER_ID) && event.user.userId === env.OWNER_USER_ID;
}

bot.onAction(CONFIRM_SEND_ACTION, async (event) => {
  if (!isOwner(event)) {
    await respondToInteraction(event.raw, 'Only the owner can confirm this.');
    return;
  }
  const id = event.value;
  const post = id ? takePendingPost(id) : null;
  if (!post) {
    await respondToInteraction(
      event.raw,
      'That confirmation expired or was already used.'
    );
    return;
  }
  try {
    let summary: string;
    if (post.kind === 'postMessage') {
      await executePostMessage(bot, {
        blocks: post.blocks,
        body: post.body,
        target: post.target,
      });
      summary = `:white_check_mark: Sent — ${post.summary}.`;
    } else if (post.kind === 'sendAsUser') {
      const result = await executeSendAsUser(post);
      if (!result.success) {
        await respondToInteraction(event.raw, `:x: ${result.error}`);
        return;
      }
      summary = `:white_check_mark: ${result.summary}`;
    } else {
      const result = await executeEditAsUser(post);
      if (!result.success) {
        await respondToInteraction(event.raw, `:x: ${result.error}`);
        return;
      }
      summary = `:white_check_mark: ${result.summary}`;
    }
    logger.info(
      { kind: post.kind, userId: event.user.userId },
      '[confirm-post] owner confirmed and sent'
    );
    await respondToInteraction(event.raw, summary);
  } catch (error) {
    logger.warn(toLogError(error), '[confirm-post] send failed');
    await respondToInteraction(
      event.raw,
      `:x: Failed to send: ${errorMessage(error)}`
    );
  }
});

bot.onAction(CONFIRM_CANCEL_ACTION, async (event) => {
  if (event.value) {
    takePendingPost(event.value);
  }
  await respondToInteraction(event.raw, ':heavy_multiplication_x: Cancelled.');
});
