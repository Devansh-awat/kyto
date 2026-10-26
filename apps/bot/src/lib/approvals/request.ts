import {
  type ApprovalRequest,
  createApprovalRequest,
  setApprovalMessage,
} from '@repo/db/queries';
import { env } from '@/env';
import { mrkdwn, plainText } from '@/harness/views';
import { bot, slack } from '@/lib/chat';
import { KEVINTON_USER_ID } from '@/lib/kevinton/identity';
import logger from '@/lib/logger';
import { mayReadChannel } from '@/lib/slack/channel-access';
import { toLogError } from '@/lib/utils/error';
import type { ApprovalKind } from './types';

export const APPROVE_ACTION = 'approval_approve';
export const DENY_ACTION = 'approval_deny';

// Enough of the body to decide on; the full text is in the payload.
const DETAIL_MAX = 700;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_MAX
    ? `${trimmed.slice(0, DETAIL_MAX)}…`
    : trimmed;
}

function approvalBlocks({
  origin,
  row,
}: {
  /** Where it was asked, when the card is not posted there. */
  origin?: string;
  row: ApprovalRequest;
}): unknown[] {
  const owner = env.OWNER_USER_ID ? `<@${env.OWNER_USER_ID}> ` : '';
  const where = origin ? ` (${origin})` : '';
  return [
    {
      text: mrkdwn(
        `${owner}:lock: *Approval needed* — <@${row.requestedBy}> asked me${where} to ${row.summary}.\nI can't do that on my own, so it's waiting on you. There's no time limit; it stays here until you decide.`
      ),
      type: 'section',
    },
    ...(row.detail
      ? [{ text: mrkdwn(`>>> ${preview(row.detail)}`), type: 'section' }]
      : []),
    {
      elements: [
        {
          action_id: APPROVE_ACTION,
          style: 'primary',
          text: plainText('Approve'),
          type: 'button',
          value: String(row.id),
        },
        {
          action_id: DENY_ACTION,
          style: 'danger',
          text: plainText('Deny'),
          type: 'button',
          value: String(row.id),
        },
      ],
      type: 'actions',
    },
  ];
}

/**
 * Queue an action for the owner and post the request PUBLICLY in the thread it
 * came from.
 *
 * Returns immediately. The turn does NOT block: a request can sit for hours,
 * and holding the agent loop open that long would burn the attempt watchdog and
 * strand every other thing the user asked for in the same message. The caller
 * tells the model the action is pending and gets on with the rest of the work.
 *
 * Public on purpose (unless the owner can't see that conversation — then the
 * card goes to the owner's DM and the thread gets a plain line). The person who asked can see that their request exists,
 * that it was not silently dropped, and (later, in the same place) what was
 * decided. The old behaviour for a non-owner was a flat refusal the asker had
 * no way to appeal, or an ephemeral only the owner ever saw.
 */
export async function requestApproval({
  detail,
  kind,
  payload,
  requestedBy,
  summary,
  threadId,
}: {
  detail?: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  requestedBy: string;
  summary: string;
  threadId: string;
}): Promise<{ id: number; message: string }> {
  // Kevinton is silent in the thread it reviews, and this posts there. Its one
  // approval (a skill proposal) is requested under kyto's bot id, in the
  // owner's DM.
  if (requestedBy === KEVINTON_USER_ID) {
    throw new Error('kevinton may not post an approval request in a thread');
  }
  const row = await createApprovalRequest({
    detail,
    kind,
    payload,
    requestedBy,
    summary,
    threadId,
  });
  try {
    const channel = slack.decodeThreadId(threadId).channel;
    // The card goes where the OWNER can click it. Asked in someone else's DM
    // or a private channel the owner isn't in, a card posted there was never
    // seen (#38 and #40 sat pending for days): it goes to the owner's DM
    // instead, and the thread gets a plain line so the asker knows it was not
    // dropped. Fails towards the owner's DM, which is never wrong.
    const ownerSees =
      !env.OWNER_USER_ID ||
      (await mayReadChannel({
        askerUserId: env.OWNER_USER_ID,
        channelId: channel,
        currentChannelId: undefined,
      }).catch(() => false));
    // `allowBroadcast` is deliberately absent: the approval message itself must
    // never ping a channel, even when what it is asking about is a broadcast.
    const target =
      ownerSees || !env.OWNER_USER_ID
        ? bot.thread(threadId)
        : await bot.openDM(env.OWNER_USER_ID);
    let origin: string | undefined;
    if (!ownerSees) {
      origin = channel.startsWith('D')
        ? 'in their DM with me'
        : `in <#${channel}>`;
    }
    const sent = await target.post({
      blocks: approvalBlocks({ origin, row }),
      fallbackText: `Approval needed: ${row.summary}`,
    });
    if (sent.id) {
      await setApprovalMessage({
        channel: slack.decodeThreadId(target.id).channel,
        id: row.id,
        ts: sent.id,
      });
    }
    if (!ownerSees) {
      await bot
        .thread(threadId)
        .post({
          markdown: `:lock: Sent to the owner for approval (request #${row.id}): ${row.summary}. Nothing happens until they decide; I'll say here when they do.`,
        })
        .catch(() => undefined);
    }
  } catch (error) {
    // The row still exists and is still approvable from the dashboard, so a
    // failed post degrades the request rather than losing it.
    logger.warn(
      { ...toLogError(error), approvalId: row.id },
      '[approvals] failed to post the approval request'
    );
  }
  logger.info(
    { approvalId: row.id, kind, requestedBy, threadId },
    '[approvals] queued for the owner'
  );
  return {
    id: row.id,
    message: `Queued for the owner's approval (request #${row.id}): ${summary}. The owner has been sent it with Approve/Deny buttons and it does NOT expire. Nothing has happened yet and you must not claim it has. Carry on with anything else that was asked; if there is nothing else, say plainly that this needs ${env.OWNER_USER_ID ? "the owner's" : 'an'} approval and stop — do not try another route around it.`,
  };
}
