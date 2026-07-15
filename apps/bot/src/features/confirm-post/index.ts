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
  const claimed = event.value ? takePendingPost(event.value) : null;
  if (!claimed) {
    await respondToInteraction(
      event.raw,
      'That confirmation expired or was already used.'
    );
    return;
  }
  const { post, settle } = claimed;
  try {
    let result: { success: boolean; summary?: string; error?: string };
    if (post.kind === 'postMessage') {
      await executePostMessage(bot, {
        blocks: post.blocks,
        body: post.body,
        identity: post.identity,
        target: post.target,
      });
      result = { success: true, summary: `Sent — ${post.summary}.` };
    } else if (post.kind === 'sendAsUser') {
      result = await executeSendAsUser(post);
    } else {
      result = await executeEditAsUser(post);
    }
    const detail = result.success
      ? (result.summary ?? 'Sent.')
      : (result.error ?? 'Send failed.');
    // Unblock the waiting tool with the real result, so the model reports the
    // truth (sent / failed) instead of a guess.
    settle({ decision: 'confirmed', detail, ok: result.success });
    logger.info(
      { kind: post.kind, ok: result.success, userId: event.user.userId },
      '[confirm-post] owner confirmed'
    );
    await respondToInteraction(
      event.raw,
      result.success ? `:white_check_mark: ${detail}` : `:x: ${detail}`
    );
  } catch (error) {
    const message = errorMessage(error);
    settle({ decision: 'confirmed', detail: message, ok: false });
    logger.warn(toLogError(error), '[confirm-post] send failed');
    await respondToInteraction(event.raw, `:x: Failed to send: ${message}`);
  }
});

bot.onAction(CONFIRM_CANCEL_ACTION, async (event) => {
  if (!isOwner(event)) {
    await respondToInteraction(event.raw, 'Only the owner can act on this.');
    return;
  }
  const claimed = event.value ? takePendingPost(event.value) : null;
  claimed?.settle({ decision: 'denied' });
  await respondToInteraction(
    event.raw,
    ":heavy_multiplication_x: Cancelled — I won't send it."
  );
});
