import { env } from '@/env';
import { runTurn } from '@/lib/agent';
import { getTurn, stopTurn, USER_ACCOUNT_TURN_SUFFIX } from '@/lib/agent/turns';
import { isUserAllowed } from '@/lib/allowed-users';
import { activeBan } from '@/lib/bans';
import { bot, slack } from '@/lib/chat';
import { isNativeCodeChannel } from '@/lib/code-channels';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import type { ActiveTurn } from '@/types/agent';

// What a Slack code channel kyto is the agent of sends kyto besides messages:
// the stop button, its per-channel slash commands (registered with the
// codeChannel tool) and the buttons and selects in its Block Kit tabs. A
// command or a click becomes that person's message to kyto in the channel:
// kyto first says in the channel who did what — the channel is one shared
// conversation, and a turn nobody can see the cause of reads as kyto talking
// to itself — then answers it like anything they typed.

// Slack's stop button: halt the turn like `!stop`. Slack updates the session's
// status itself. Only the person the turn is answering (or the owner) may stop
// it (owner's call 2026-10-17): in a shared channel anyone could otherwise cut
// off someone else's answer. A click without a user id stops nothing.
bot.onAgentSessionStopped(async ({ channelId, threadTs, userId }) => {
  if (!channelId) {
    return;
  }
  const threadId = slack.encodeThreadId({
    channel: channelId,
    threadTs: threadTs ?? '',
  });
  const mayStop = (turn: ActiveTurn) =>
    userId !== undefined &&
    (userId === env.OWNER_USER_ID || turn.message?.author.userId === userId);
  const running = [threadId, `${threadId}${USER_ACCOUNT_TURN_SUFFIX}`].flatMap(
    (slot) => getTurn({ threadId: slot }) ?? []
  );
  const stopped = stopTurn({ mayStop, threadId });
  logger.info(
    { stopped, threadId, userId },
    '[code-channel] stop button pressed'
  );
  if (stopped || running.length === 0 || !userId) {
    return;
  }
  const authors = [
    ...new Set(running.flatMap((turn) => turn.message?.author.userId ?? [])),
  ];
  await slack.webClient.chat
    .postEphemeral({
      channel: channelId,
      text: `Only ${authors.length > 0 ? authors.map((id) => `<@${id}>`).join(' or ') : 'the person who asked'} can stop this answer.`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      user: userId,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), threadId },
        '[code-channel] could not explain a refused stop'
      );
    });
});

bot.onUnhandledAction(async (event) => {
  const { channel } = slack.decodeThreadId(event.threadId);
  if (!(channel && isNativeCodeChannel(channel))) {
    return;
  }
  const label = event.value
    ? `${event.actionId} (value: ${event.value})`
    : event.actionId;
  await handToKyto({
    channel,
    notice: `<@${event.user.userId}> used \`${label}\` in a tab`,
    text: `[used ${label} in one of your Block Kit tabs]`,
    userId: event.user.userId,
  });
});

/**
 * One of the code channel's own slash commands. Returns null (nothing to say
 * in the ack: the answer is the turn) or undefined when it isn't one.
 */
export function runCodeChannelCommand({
  channelId,
  command,
  text,
  userId,
}: {
  channelId: string;
  command: string;
  text: string;
  userId: string;
}): Promise<null | undefined> {
  if (!isNativeCodeChannel(channelId)) {
    return Promise.resolve(undefined);
  }
  const invocation = `${command} ${text}`.trim();
  // Not awaited: Slack wants the ack within three seconds.
  handToKyto({
    channel: channelId,
    notice: `<@${userId}> ran \`${invocation}\``,
    text: invocation,
    userId,
  }).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), channelId, command },
      '[code-channel] command failed'
    );
  });
  return Promise.resolve(null);
}

async function handToKyto({
  channel,
  notice,
  text,
  userId,
}: {
  channel: string;
  notice: string;
  text: string;
  userId: string;
}): Promise<void> {
  // The same gates as a message they typed: bans, then the opt-in.
  if ((await activeBan(userId)) !== null || !(await isUserAllowed(userId))) {
    return;
  }
  const threadId = slack.encodeThreadId({ channel, threadTs: '' });
  const thread = bot.thread(threadId);
  const sent = await thread.post(notice);
  await runTurn({
    message: {
      attachments: [],
      author: await slack.getUser(userId),
      id: sent.id,
      isMention: true,
      metadata: { dateSent: new Date() },
      raw: {},
      text,
      threadId,
    },
    thread,
  });
}
