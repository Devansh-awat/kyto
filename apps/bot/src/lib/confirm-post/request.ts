import type { ThreadHandle } from '@/harness';
import { mrkdwn, plainText } from '@/harness/views';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import {
  CONFIRM_WAIT_MS,
  type ConfirmOutcome,
  discardPendingPost,
  type PendingPost,
  stashPendingPost,
} from './pending';

/** What the tool hands back to the model once the owner has (or hasn't) acted. */
export type ConfirmResult =
  | { success: true; summary: string }
  | { success: false; denied?: boolean; error?: string; summary?: string };

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

function outcomeToResult(
  outcome: ConfirmOutcome | null,
  post: PendingPost,
  aborted: boolean
): ConfirmResult {
  if (outcome?.decision === 'confirmed') {
    return outcome.ok
      ? { success: true, summary: outcome.detail }
      : { error: outcome.detail, success: false };
  }
  if (outcome?.decision === 'denied') {
    return {
      denied: true,
      success: false,
      summary: `The owner denied this — I did NOT ${post.summary}. Do not retry it; acknowledge that they declined.`,
    };
  }
  return {
    success: false,
    summary: aborted
      ? `Interrupted before the owner responded — I did NOT ${post.summary}.`
      : `The owner did not respond within ${Math.round(
          CONFIRM_WAIT_MS / 60_000
        )} minutes — I did NOT ${post.summary}. You can ask them again.`,
  };
}

/**
 * Hold an outward-facing post (cross-channel, or as the owner), show the owner
 * an ephemeral Confirm/Cancel button in the current thread, and BLOCK until
 * they choose (or the wait times out / the turn aborts). Returns the real
 * outcome so the model can say it sent it, that the owner declined, or that
 * nobody answered — never a premature "waiting…". Nothing is sent here; the
 * button handler performs the send and reports back through the pending row.
 */
export async function requestPostConfirmation({
  abortSignal,
  extendAttemptDeadline,
  ownerUserId,
  post,
  thread,
}: {
  abortSignal?: AbortSignal;
  extendAttemptDeadline?: (extraMs: number) => void;
  ownerUserId: string;
  post: PendingPost;
  thread: ThreadHandle;
}): Promise<ConfirmResult> {
  const { id, wait } = stashPendingPost(post);
  const delivered = await thread.postEphemeral(
    ownerUserId,
    `Confirm before I send: ${post.summary}`,
    { blocks: confirmBlocks(id, post), fallbackToDM: true }
  );
  // Remember a DM-delivered prompt so the button handler can EDIT it instead of
  // replying beside it. `replace_original` only works on a message Slack owns
  // through the interaction; on an ordinary DM it silently does nothing, so the
  // outcome arrived as a second message and the original stayed put with its
  // Confirm button still clickable.
  if (delivered.delivery === 'dm' && delivered.channel && delivered.ts) {
    rememberPromptMessage(id, {
      channel: delivered.channel,
      ts: delivered.ts,
    });
  }

  // Tell the attempt watchdog this deliberate pause isn't a stall (same as the
  // `wait` tool), so a slow decision doesn't get the turn killed mid-wait.
  extendAttemptDeadline?.(CONFIRM_WAIT_MS + 30_000);

  const outcome = await new Promise<ConfirmOutcome | null>((resolve) => {
    let done = false;
    const finish = (value: ConfirmOutcome | null) => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      discardPendingPost(id);
      promptMessages.delete(id);
      finish(null);
    }, CONFIRM_WAIT_MS);
    const onAbort = () => {
      clearTimeout(timer);
      discardPendingPost(id);
      promptMessages.delete(id);
      finish(null);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    wait.then((value) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      finish(value);
    });
  });

  return outcomeToResult(outcome, post, Boolean(abortSignal?.aborted));
}

const interactionSchema = { response_url: '' };

// Confirm prompts that were delivered as a real DM (the ephemeral fallback),
// keyed by pending-post id, so the outcome can edit that message rather than
// pile up beside it. Cleared when claimed; a leftover row is bounded by the
// pending post's own lifetime.
const promptMessages = new Map<string, { channel: string; ts: string }>();

function rememberPromptMessage(
  id: string,
  location: { channel: string; ts: string }
): void {
  promptMessages.set(id, location);
}

/**
 * Show the outcome in place of the confirm prompt.
 *
 * Two delivery shapes, two mechanisms: a true ephemeral is replaced through the
 * interaction's `response_url`, and a DM-fallback message is edited with
 * `chat.update`. Using `replace_original` on the latter is a no-op — which is
 * how a confirmed post ended up with the result posted BESIDE a prompt whose
 * buttons were still live.
 */
export async function respondToInteraction(
  raw: unknown,
  text: string,
  pendingId?: string
): Promise<void> {
  const dmPrompt = pendingId ? promptMessages.get(pendingId) : undefined;
  if (dmPrompt) {
    promptMessages.delete(pendingId as string);
    try {
      await slack.webClient.chat.update({
        blocks: [{ text: mrkdwn(text), type: 'section' }],
        channel: dmPrompt.channel,
        text,
        ts: dmPrompt.ts,
      });
      return;
    } catch (error) {
      logger.warn(
        toLogError(error),
        '[confirm-post] failed to update the DM prompt; falling back to response_url'
      );
    }
  }
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
