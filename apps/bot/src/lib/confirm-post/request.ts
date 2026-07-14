import type { ThreadHandle } from '@/harness';
import { mrkdwn, plainText } from '@/harness/views';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { type PendingPost, stashPendingPost } from './pending';

export const CONFIRM_SEND_ACTION = 'confirm_post_send';
export const CONFIRM_CANCEL_ACTION = 'confirm_post_cancel';

// Slack truncates the preview if it's enormous; keep it readable.
const PREVIEW_MAX = 500;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_MAX
    ? `${trimmed.slice(0, PREVIEW_MAX)}…`
    : trimmed;
}

function confirmBlocks(id: string, post: PendingPost): unknown[] {
  const bodyPreview = post.kind === 'postMessage' ? post.body : post.text;
  return [
    {
      type: 'section',
      text: mrkdwn(`:lock: *Confirm before I send this*\n${post.summary}`),
    },
    ...(bodyPreview.trim()
      ? [
          {
            type: 'section',
            text: mrkdwn(`>>> ${preview(bodyPreview)}`),
          },
        ]
      : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CONFIRM_SEND_ACTION,
          style: 'primary',
          text: plainText('Confirm & send'),
          value: id,
        },
        {
          type: 'button',
          action_id: CONFIRM_CANCEL_ACTION,
          style: 'danger',
          text: plainText('Cancel'),
          value: id,
        },
      ],
    },
  ];
}

/**
 * Hold an outward-facing post (cross-channel, or as the owner) and show the
 * owner an ephemeral confirm button in the current thread. Nothing is sent
 * until they click. Returns the string the tool hands back to the model so it
 * tells the user to look for the confirmation instead of claiming it posted.
 */
export async function requestPostConfirmation({
  ownerUserId,
  post,
  thread,
}: {
  ownerUserId: string;
  post: PendingPost;
  thread: ThreadHandle;
}): Promise<{ awaitingConfirmation: true; summary: string }> {
  const id = stashPendingPost(post);
  await thread.postEphemeral(
    ownerUserId,
    `Confirm before I send: ${post.summary}`,
    { blocks: confirmBlocks(id, post), fallbackToDM: true }
  );
  return {
    awaitingConfirmation: true,
    summary: `Waiting for the owner to confirm: ${post.summary}. I posted a Confirm/Cancel button that only they can see — nothing is sent until they click Confirm.`,
  };
}

const interactionSchema = { response_url: '' };

/** Replace the ephemeral confirm message with a result, via its response_url. */
export async function respondToInteraction(
  raw: unknown,
  text: string
): Promise<void> {
  const responseUrl = (raw as Partial<typeof interactionSchema> | undefined)
    ?.response_url;
  if (!responseUrl) {
    return;
  }
  try {
    await fetch(responseUrl, {
      body: JSON.stringify({
        replace_original: true,
        text,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch (error) {
    logger.warn(toLogError(error), '[confirm-post] failed to update ephemeral');
  }
}
