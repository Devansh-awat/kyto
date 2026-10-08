import { clearThreadSummary, clearThreadThinking } from '@repo/db/queries';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { env } from '@/env';
import type { MessageShortcutEvent } from '@/harness/types';
import { mrkdwn, plainText } from '@/harness/views';
import { stopTurn } from '@/lib/agent/turns';
import { bot, slack } from '@/lib/chat';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// Two owner-only message shortcuts for cleaning up a thread: delete every kyto
// reply in it, or delete one message. Both also make kyto forget the thread's
// derived context (stored reasoning and the compacted digest) — its memory of
// a thread IS the Slack thread plus those, so after this the next turn starts
// from what is left in Slack.

const DELETE_REPLIES_SHORTCUT = 'delete_kyto_replies';
const DELETE_MESSAGE_SHORTCUT = 'delete_message';
const CONFIRM_CALLBACK = 'delete_kyto_replies_confirm';
const REPLIES_PAGE_SIZE = 200;

// Round-tripped through the modal, so parsed, not trusted; the submitter is
// re-checked against the owner on submit.
const metadataSchema = z.object({
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});

/** Which of kyto's two identities posted it, if either. */
type KytoIdentity = 'app' | 'account';

function kytoIdentityOf({
  botId,
  userId,
}: {
  botId?: string;
  userId?: string;
}): KytoIdentity | undefined {
  if (
    (botId && botId === slack.botId) ||
    (userId && userId === slack.botUserId)
  ) {
    return 'app';
  }
  if (userId && userId === slack.userAccountId) {
    return 'account';
  }
  return;
}

// The account deletes only its OWN messages here — the session is never a
// general "act as that account" path.
function clientFor(identity: KytoIdentity): WebClient {
  return identity === 'app'
    ? slack.webClient
    : slack.requireUserAccountClient();
}

async function tell({
  channelId,
  responseUrl,
  text,
  threadTs,
  userId,
}: {
  channelId: string;
  responseUrl?: string;
  text: string;
  threadTs: string;
  userId: string;
}): Promise<void> {
  if (responseUrl) {
    await fetch(responseUrl, {
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ response_type: 'ephemeral', text }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }).catch(() => undefined);
    return;
  }
  await slack.webClient.chat
    .postEphemeral({
      channel: channelId,
      text,
      thread_ts: threadTs,
      user: userId,
    })
    .catch(() => undefined);
}

async function forgetThread(threadId: string): Promise<void> {
  await Promise.all([
    clearThreadThinking(threadId),
    clearThreadSummary(threadId),
  ]).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), threadId },
      '[thread-cleanup] could not clear the thread context'
    );
  });
}

const replyPageSchema = z.object({
  messages: z
    .array(
      z.looseObject({
        bot_id: z.string().optional(),
        ts: z.string(),
        user: z.string().optional(),
      })
    )
    .optional(),
  response_metadata: z
    .looseObject({ next_cursor: z.string().optional() })
    .optional(),
});

/** Every message either kyto posted in the thread, root included. */
async function kytoMessagesIn({
  channelId,
  threadTs,
}: {
  channelId: string;
  threadTs: string;
}): Promise<{ identity: KytoIdentity; ts: string }[]> {
  // The app can't read a DM or private channel it isn't in; the account,
  // which may have been the one talking there, can.
  const readers = [slack.webClient];
  if (slack.userAccountId) {
    readers.push(slack.requireUserAccountClient());
  }
  let lastError: unknown;
  for (const client of readers) {
    try {
      const found: { identity: KytoIdentity; ts: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = replyPageSchema.parse(
          await client.conversations.replies({
            channel: channelId,
            cursor,
            limit: REPLIES_PAGE_SIZE,
            ts: threadTs,
          })
        );
        for (const message of page.messages ?? []) {
          const identity = kytoIdentityOf({
            botId: message.bot_id,
            userId: message.user,
          });
          if (identity) {
            found.push({ identity, ts: message.ts });
          }
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return found;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not read the thread.');
}

async function deleteKytoReplies({
  channelId,
  ownerId,
  threadTs,
}: {
  channelId: string;
  ownerId: string;
  threadTs: string;
}): Promise<void> {
  const threadId = slack.encodeThreadId({ channel: channelId, threadTs });
  // A turn still running would keep posting into the thread being cleared.
  stopTurn({ threadId });
  let deleted = 0;
  let failed = 0;
  try {
    for (const { identity, ts } of await kytoMessagesIn({
      channelId,
      threadTs,
    })) {
      try {
        await clientFor(identity).chat.delete({ channel: channelId, ts });
        deleted += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          { ...toLogError(error), channelId, identity, ts },
          '[thread-cleanup] could not delete a kyto message'
        );
      }
    }
  } catch (error) {
    logger.warn(
      { ...toLogError(error), threadId },
      '[thread-cleanup] could not list the thread'
    );
    await tell({
      channelId,
      text: `Couldn't read this thread to clean it up: ${toLogError(error).err.message}`,
      threadTs,
      userId: ownerId,
    });
    return;
  }
  await forgetThread(threadId);
  logger.info({ deleted, failed, threadId }, '[thread-cleanup] thread cleared');
  await tell({
    channelId,
    text: `Deleted ${deleted} kyto message${deleted === 1 ? '' : 's'}${failed ? ` (${failed} couldn't be deleted)` : ''} and cleared kyto's memory of this thread.`,
    threadTs,
    userId: ownerId,
  });
}

function isOwner(userId: string): boolean {
  return Boolean(env.OWNER_USER_ID) && userId === env.OWNER_USER_ID;
}

async function refuseNonOwner(event: MessageShortcutEvent): Promise<boolean> {
  if (isOwner(event.user.userId)) {
    return false;
  }
  await tell({
    channelId: event.channelId,
    responseUrl: event.responseUrl,
    text: 'Only the bot owner can use this.',
    threadTs: event.message.threadTs ?? event.message.ts,
    userId: event.user.userId,
  });
  return true;
}

bot.onMessageShortcut(DELETE_REPLIES_SHORTCUT, async (event) => {
  if (await refuseNonOwner(event)) {
    return;
  }
  const threadTs = event.message.threadTs ?? event.message.ts;
  const metadata = { channelId: event.channelId, threadTs };
  // Counted now for the confirmation; deleted from a fresh read on submit.
  const count = await kytoMessagesIn(metadata)
    .then((found) => found.length)
    .catch(() => undefined);
  await slack.webClient.views
    .open({
      trigger_id: event.triggerId,
      view: {
        blocks: [
          {
            text: mrkdwn(
              `${count === undefined ? 'Delete every kyto message' : `Delete *${count}* kyto message${count === 1 ? '' : 's'}`} in this thread (the app's and kyto's account's), stop anything kyto is running here, and clear its stored reasoning and summary of the thread?\n\nThis can't be undone.`
            ),
            type: 'section',
          },
        ],
        callback_id: CONFIRM_CALLBACK,
        close: plainText('Cancel'),
        private_metadata: JSON.stringify(metadata),
        submit: plainText('Delete'),
        title: plainText('Clean up thread'),
        type: 'modal',
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        toLogError(error),
        '[thread-cleanup] could not open the confirmation'
      );
    });
});

bot.onModalSubmit(CONFIRM_CALLBACK, (event) => {
  if (!isOwner(event.user.userId)) {
    return { action: 'clear' };
  }
  const parsed = metadataSchema.safeParse(
    (() => {
      try {
        return JSON.parse(event.privateMetadata ?? '');
      } catch {
        return null;
      }
    })()
  );
  if (!parsed.success) {
    return { action: 'clear' };
  }
  // Slack wants the modal answered within 3s; a long thread takes longer to
  // delete (chat.delete is rate limited), so the result comes as an ephemeral.
  deleteKytoReplies({ ...parsed.data, ownerId: event.user.userId }).catch(
    (error: unknown) => {
      logger.error(toLogError(error), '[thread-cleanup] clean-up failed');
    }
  );
  return { action: 'clear' };
});

bot.onMessageShortcut(DELETE_MESSAGE_SHORTCUT, async (event) => {
  if (await refuseNonOwner(event)) {
    return;
  }
  const { channelId, message } = event;
  const threadTs = message.threadTs ?? message.ts;
  const identity = kytoIdentityOf(message);
  // kyto's own messages as whichever kyto posted them; the owner's own with
  // his token. Slack lets only workspace admins delete other people's.
  const ownMessage = message.userId === event.user.userId;
  const say = (text: string) =>
    tell({
      channelId,
      responseUrl: event.responseUrl,
      text,
      threadTs,
      userId: event.user.userId,
    });
  if (!(identity || (ownMessage && env.SLACK_USER_TOKEN))) {
    await say(
      "That's someone else's message, and Slack only lets workspace admins delete those."
    );
    return;
  }
  try {
    await (identity
      ? clientFor(identity).chat.delete({ channel: channelId, ts: message.ts })
      : slack.webClient.chat.delete({
          channel: channelId,
          token: env.SLACK_USER_TOKEN,
          ts: message.ts,
        }));
  } catch (error) {
    await say(`Couldn't delete it: ${toLogError(error).err.message}`);
    return;
  }
  // The message is gone from the history kyto reads, but its stored reasoning
  // or digest may still quote it.
  await forgetThread(slack.encodeThreadId({ channel: channelId, threadTs }));
  await say("Deleted, and cleared kyto's memory of this thread.");
});
