import { runTurn } from '@/lib/agent';
import { stopTurn } from '@/lib/agent/turns';
import { isUserAllowed } from '@/lib/allowed-users';
import { activeBan } from '@/lib/bans';
import { bot, slack } from '@/lib/chat';
import { isNativeCodeChannel } from '@/lib/code-channels';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';

// What a Slack code channel kyto is the agent of sends kyto besides messages:
// the stop button, its per-channel slash commands (registered with the
// codeChannel tool) and the buttons and selects in its Block Kit tabs. A
// command or a click becomes that person's message to kyto in the channel:
// kyto first says in the channel who did what — the channel is one shared
// conversation, and a turn nobody can see the cause of reads as kyto talking
// to itself — then answers it like anything they typed.

// Slack's stop button: halt the turn like `!stop`. Slack updates the session's
// status itself.
bot.onAgentSessionStopped(({ channelId, threadTs }) => {
  if (!channelId) {
    return Promise.resolve();
  }
  const threadId = slack.encodeThreadId({
    channel: channelId,
    threadTs: threadTs ?? '',
  });
  const stopped = stopTurn({ threadId });
  logger.info({ stopped, threadId }, '[code-channel] stop button pressed');
  return Promise.resolve();
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
