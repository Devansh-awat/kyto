import {
  claimAsUserRequest,
  finishAsUserRequest,
  setReminderAsUserApproval,
} from '@repo/db/queries';
import { env } from '@/env';
import type { ActionEvent } from '@/harness/types';
import { mrkdwn } from '@/harness/views';
import { executePostMessage } from '@/lib/ai/tools/post-message';
import {
  AS_USER_ALWAYS_ACTION,
  AS_USER_CANCEL_ACTION,
  AS_USER_SEND_ONCE_ACTION,
  asUserPostSchema,
  executeAsUser,
  executeDeleteAsUser,
  executeEditAsUser,
  executeSendAsUser,
} from '@/lib/ai/tools/send-as-user';
import { bot, slack } from '@/lib/chat';
import {
  type PendingPost,
  peekPendingPost,
  takePendingPost,
} from '@/lib/confirm-post/pending';
import {
  CONFIRM_CANCEL_ACTION,
  CONFIRM_SEND_ACTION,
  respondToInteraction,
} from '@/lib/confirm-post/request';
import logger from '@/lib/logger';
import { errorMessage, toLogError } from '@/lib/utils/error';

// Who this row's buttons belong to: the person named on it when the request was
// MADE (an impersonated post asks the person being impersonated; a send, edit or
// delete from someone's own account asks them), else the owner. Taken from the
// row, never from the click.
function approverOf(post: PendingPost): string | undefined {
  if (post.kind !== 'postMessage') {
    return post.requestedBy;
  }
  return post.approverUserId ?? env.OWNER_USER_ID;
}

// The ephemeral is only shown to that person, but a crafted interaction payload
// could still target the action id, so re-check the clicker here — this button is
// the last line of defense against a prompt injection driving an outward-facing
// post.
function mayDecide(event: ActionEvent, post: PendingPost): boolean {
  const approver = approverOf(post);
  return Boolean(approver) && event.user.userId === approver;
}

const NOT_YOURS = 'This confirmation is not yours to decide.';
const GONE = 'That confirmation expired or was already used.';

/**
 * The clicker's right to decide is checked BEFORE the row is claimed: claiming
 * first would let a stranger's click consume a confirmation the real approver
 * still has to answer (they would find nothing left to press). Double-click
 * protection is unaffected — that comes from `takePendingPost` deleting the row.
 */
function claimIfAllowed(event: ActionEvent) {
  const id = event.value;
  if (!id) {
    return { error: GONE } as const;
  }
  const peeked = peekPendingPost(id);
  if (!peeked) {
    return { error: GONE } as const;
  }
  if (!mayDecide(event, peeked)) {
    return { error: NOT_YOURS } as const;
  }
  const claimed = takePendingPost(id);
  return claimed ? ({ claimed } as const) : ({ error: GONE } as const);
}

bot.onAction(CONFIRM_SEND_ACTION, async (event) => {
  const outcome = claimIfAllowed(event);
  if (outcome.error) {
    await respondToInteraction(event.raw, outcome.error);
    return;
  }
  const { post, settle } = outcome.claimed;
  try {
    let result: { success: boolean; summary?: string; error?: string };
    if (post.kind === 'postMessage') {
      await executePostMessage(bot, {
        blocks: post.blocks,
        body: post.body,
        fromUserAccount: post.fromUserAccount,
        identity: post.identity,
        target: post.target,
      });
      result = { success: true, summary: `Sent — ${post.summary}.` };
    } else if (post.kind === 'sendAsUser') {
      result = await executeSendAsUser(post);
    } else if (post.kind === 'editAsUser') {
      result = await executeEditAsUser(post);
    } else {
      result = await executeDeleteAsUser(post);
    }
    const detail = result.success
      ? (result.summary ?? 'Sent.')
      : (result.error ?? 'Send failed.');
    // Unblock the waiting tool with the real result, so the model reports the
    // truth (sent / failed) instead of a guess.
    settle({ decision: 'confirmed', detail, ok: result.success });
    logger.info(
      {
        impersonated:
          post.kind === 'postMessage' ? Boolean(post.approverUserId) : false,
        kind: post.kind,
        ok: result.success,
        userId: event.user.userId,
      },
      '[confirm-post] approver confirmed'
    );
    await respondToInteraction(
      event.raw,
      result.success ? `:white_check_mark: ${detail}` : `:x: ${detail}`,
      event.value
    );
  } catch (error) {
    const message = errorMessage(error);
    settle({ decision: 'confirmed', detail: message, ok: false });
    logger.warn(toLogError(error), '[confirm-post] send failed');
    await respondToInteraction(
      event.raw,
      `:x: Failed to send: ${message}`,
      event.value
    );
  }
});

bot.onAction(CONFIRM_CANCEL_ACTION, async (event) => {
  const outcome = claimIfAllowed(event);
  if (outcome.error) {
    await respondToInteraction(event.raw, outcome.error);
    return;
  }
  outcome.claimed.settle({ decision: 'denied' });
  await respondToInteraction(
    event.raw,
    ":heavy_multiplication_x: Cancelled — I won't send it.",
    event.value
  );
});

// ── A scheduled job's saved request to act as its creator ────────────────────

/**
 * The DM card a reminder run left (`saveForLater` in send-as-user.ts). The
 * claim's WHERE checks the clicker is the person acted as, the row is still
 * pending and under a day old, so a stale or double click does nothing. What
 * runs is the row's payload, re-validated, never anything from the click.
 */
async function answerAsUserRequest(
  event: ActionEvent,
  decision: 'always' | 'cancel' | 'once'
): Promise<void> {
  const id = event.value;
  const userId = event.user.userId;
  if (!id) {
    return;
  }
  const row = await claimAsUserRequest({
    id,
    status: decision === 'cancel' ? 'cancelled' : 'sending',
    userId,
  }).catch((error: unknown) => {
    logger.warn(toLogError(error), '[as-user-request] claim failed');
    return null;
  });
  if (!row) {
    await respondToInteraction(
      event.raw,
      'That request expired (they last 24 hours) or was already answered.'
    );
    return;
  }
  let outcome = `:no_entry_sign: Cancelled — I did not ${row.summary}.`;
  if (decision !== 'cancel') {
    const parsed = asUserPostSchema.safeParse(row.payload);
    const result =
      parsed.success && parsed.data.requestedBy === userId
        ? await executeAsUser(parsed.data).catch((error: unknown) => ({
            error: errorMessage(error),
            success: false,
          }))
        : { error: 'The saved request is unreadable.', success: false };
    await finishAsUserRequest({ id, ok: result.success }).catch(
      () => undefined
    );
    outcome = result.success
      ? `:white_check_mark: ${'summary' in result ? result.summary : 'Sent.'}`
      : `:x: ${result.error ?? 'Failed.'}`;
    if (decision === 'always' && row.reminderId) {
      const set = await setReminderAsUserApproval({
        approval: 'always',
        id: row.reminderId,
        userId,
      }).catch(() => false);
      outcome += set
        ? '\nThis job now acts as you without asking. Change that in App Home.'
        : "\nCouldn't change the job's setting (it may be gone).";
    }
  }
  logger.info(
    { decision, reminderId: row.reminderId, userId },
    '[as-user-request] answered'
  );
  if (row.cardChannel && row.cardTs) {
    await slack.webClient.chat
      .update({
        blocks: [{ text: mrkdwn(outcome), type: 'section' }],
        channel: row.cardChannel,
        text: outcome,
        ts: row.cardTs,
      })
      .catch((error: unknown) => {
        logger.warn(toLogError(error), '[as-user-request] card update failed');
      });
    return;
  }
  await respondToInteraction(event.raw, outcome);
}

bot.onAction(AS_USER_SEND_ONCE_ACTION, (event) =>
  answerAsUserRequest(event, 'once')
);
bot.onAction(AS_USER_ALWAYS_ACTION, (event) =>
  answerAsUserRequest(event, 'always')
);
bot.onAction(AS_USER_CANCEL_ACTION, (event) =>
  answerAsUserRequest(event, 'cancel')
);
