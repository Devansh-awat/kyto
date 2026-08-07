import { getSlackGrant } from '@repo/db/queries';
import type { Message, ThreadHandle as Thread } from '@/harness';
import { runTurn } from '@/lib/agent';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  deleteMessageAsUser,
  slackAuthorizeUrl,
  slackOauthConfigured,
} from '@/lib/slack-oauth';
import { rawText, withoutLeadingMentions } from '@/lib/utils/message';

/**
 * `@kyto!secret <question>` — ask privately.
 *
 * Three things happen, and all three are needed for the promise to hold:
 *   1. the question message is DELETED, using the asker's own Slack token;
 *   2. the answer comes back as an ephemeral, visible to nobody else;
 *   3. the turn leaves no persisted trace kyto can read back — no
 *      `thread_thinking`, and the exchange is not in Slack to be replayed.
 *
 * So asking again later, with or without `!secret`, and anyone else asking
 * "what did you just tell them?", both find nothing. That is the whole feature:
 * an ephemeral answer whose QUESTION is still sitting in the channel is not
 * private, and one kyto can recite next turn is not private either.
 *
 * Which is why an unauthorized user is REFUSED rather than answered (owner's
 * call, 2026-08-07): a half-secret that silently leaves the question up is
 * worse than a clear "connect your account first", because the person has
 * already typed the private thing by then.
 */

const SECRET_COMMAND = /^!secret\b\s*(.*)$/is;

/** The question, if this message is a `!secret` request. */
export function secretQuestion(message: Message): string | null {
  const body = withoutLeadingMentions(rawText(message)).trim();
  const match = SECRET_COMMAND.exec(body);
  return match ? (match[1] ?? '').trim() : null;
}

/**
 * Handle a `!secret` message. Returns true when it was handled (answered, or
 * refused with a reason), false when this isn't one.
 */
export async function handleSecret({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<boolean> {
  const question = secretQuestion(message);
  if (question === null) {
    return false;
  }
  const userId = message.author.userId;
  if (!slackOauthConfigured()) {
    await tell(
      thread,
      message,
      "i can't do `!secret` here — connecting a Slack account isn't set up on this instance, so i have no way to delete your question afterwards."
    );
    return true;
  }
  const grant = await getSlackGrant(userId).catch(() => null);
  if (!grant) {
    const url = slackAuthorizeUrl(userId);
    await tell(
      thread,
      message,
      `to use \`!secret\` i need to be able to delete your question afterwards, and only your own Slack account can do that. connect it here and ask again: ${url}\n\n(the link is yours alone and expires in 15 minutes. i haven't read your question — delete the message yourself for now.)`
    );
    return true;
  }
  if (!question) {
    await tell(thread, message, 'ask me something after `!secret`.');
    return true;
  }
  // Delete FIRST, before the model runs. A turn can take minutes, and the
  // question is the part sitting in a public channel — leaving it up while
  // kyto thinks is the window this feature exists to close.
  const { channel } = slack.decodeThreadId(thread.id);
  const deleted = await deleteMessageAsUser({
    channel,
    ts: message.id,
    userId,
  });
  if (!deleted) {
    await tell(
      thread,
      message,
      "i couldn't delete your message — your Slack authorization may have been revoked. i haven't answered; reconnect from my App Home and try again."
    );
    return true;
  }
  logger.info(
    { threadId: thread.id, userId },
    '[secret] answering privately and leaving no trace'
  );
  // The question is gone from Slack, so buildPrompt will not see it — hand the
  // model the text directly by answering the message object we still hold.
  await runTurn({ message, secret: true, thread });
  return true;
}

function tell(
  thread: Thread,
  message: Message,
  text: string
): Promise<unknown> {
  return thread
    .postEphemeral(message.author, text, { fallbackToDM: false })
    .catch((error: unknown) => {
      logger.warn(
        { err: error, threadId: thread.id },
        '[secret] could not reach the asker'
      );
    });
}
