import { env } from '@/env';
import type { KytoBot, Message, ThreadHandle as Thread } from '@/harness';
import { runTurn, stopTurn } from '@/lib/agent';
import { isFocusAllowed } from '@/lib/agent/focus';
import { isUserAllowed } from '@/lib/allowed-users';
import { activeBan, banNotice, runBanCommand } from '@/lib/bans';
import { allowBotTurn, noteHumanMessage } from '@/lib/bot-pings';
import { bot, slack, userBot } from '@/lib/chat';
import { isCodeChannel } from '@/lib/code-channels';
import { handleCommand } from '@/lib/commands';
import logger from '@/lib/logger';
import {
  acceptOptIn,
  OPT_IN_ACCEPT_ACTION,
  OPT_IN_NO_JOIN_ACTION,
  offerOptIn,
} from '@/lib/onboarding';
import { handleSecret } from '@/lib/secret';
import { toLogError } from '@/lib/utils/error';
import {
  isAddressedOnly,
  isHiddenFromBot,
  rawSlackText,
} from '@/lib/utils/message';
import '@/features/approvals';
import '@/features/ask-question';
import '@/features/assistant';
import '@/features/confirm-post';
import '@/features/customizations';
import '@/features/feedback';
import '@/features/mcp-permissions';
import '@/features/poll';

export { bot } from '@/lib/chat';

listen(bot);
if (userBot) {
  listen(userBot);
}

// Messages the ACCOUNT has already taken, from either connection: a channel
// message can reach it through both, and must be answered once.
const accountSeen = new Set<string>();
const ACCOUNT_SEEN_LIMIT = 1000;

function firstTimeForAccount(message: Message): boolean {
  const key = `${message.threadId}:${message.id}`;
  if (accountSeen.has(key)) {
    return false;
  }
  accountSeen.add(key);
  if (accountSeen.size > ACCOUNT_SEEN_LIMIT) {
    const oldest = accountSeen.values().next().value;
    if (oldest) {
      accountSeen.delete(oldest);
    }
  }
  return true;
}

function pingsAccount(message: Message): boolean {
  return Boolean(
    slack.userAccountId &&
      (rawSlackText(message) ?? '').includes(`<@${slack.userAccountId}>`)
  );
}

/**
 * A channel message, handed to the ACCOUNT. Slack only delivers the account's
 * DMs to its events app (channel messages never arrive there), so the APP's
 * connection — which sees every message in the channels it is in — passes on
 * the ones the account should hear: a ping of it, or a reply in a thread it
 * follows (answerThreadMessage checks that). Needs only the account's session.
 */
async function answerAsAccount({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (!slack.userAccountId) {
    return;
  }
  const pinged = pingsAccount(message);
  const asAccount = { ...message, isMention: pinged };
  if (pinged) {
    if (firstTimeForAccount(message)) {
      await answerMention({ asUserAccount: true, message: asAccount, thread });
    }
    return;
  }
  // Only a thread the account follows is worth claiming the message for.
  const state = await thread.state;
  if (
    state?.respondOnThreadMessages === true &&
    state.respondAs === 'user' &&
    firstTimeForAccount(message)
  ) {
    await answerThreadMessage({
      asUserAccount: true,
      message: asAccount,
      thread,
    });
  }
}

/**
 * The same gates on both connections: the app, and kyto's Slack USER account
 * (lib/chat `userBot`). Only who answers differs — the account answers as a
 * person would, through its own session (runTurn `asUserAccount`).
 */
function listen(target: KytoBot): void {
  const asUserAccount = target.answersAs === 'user';
  target.onNewMention(async (thread, message) => {
    if (asUserAccount) {
      if (firstTimeForAccount(message)) {
        await answerMention({ asUserAccount, message, thread });
      }
      return;
    }
    // The user account pinging the app: its posts are `isMe` (so neither kyto
    // answers its own words), which dropped this ping too. Answered as a bot's
    // ping instead — explicit mention only, the bot-loop cap, never joining the
    // thread. One way only: the account still ignores the app, so the two can't
    // ping-pong.
    if (message.author.userId === slack.userAccountId) {
      await answerMention({
        asUserAccount,
        message: {
          ...message,
          author: { ...message.author, isBot: true, isMe: false },
        },
        thread,
      });
      return;
    }
    // Not awaited one after the other: each resolves only when its whole
    // turn is done, and a message pinging both kytos is for both.
    await Promise.all([
      answerMention({ asUserAccount, message, thread }),
      answerAsAccount({ message, thread }),
    ]);
  });
  target.onDirectMessage(async (thread, message) => {
    if (asUserAccount && !firstTimeForAccount(message)) {
      return;
    }
    // Bots are answered on a mention in a shared room, not in a DM with nobody
    // human watching the two of them talk.
    if (shouldIgnore(message) || message.author.isBot === true) {
      return;
    }
    if (await refuseBanned(thread, message)) {
      return;
    }
    if (!(await isUserAllowed(message.author.userId))) {
      await offerOptInAs({ asUserAccount, message, thread });
      return;
    }
    await thread.subscribe();
    await runCommandOrTurn({ asUserAccount, message, thread });
  });
  target.onSubscribedMessage(async (thread, message) => {
    if (asUserAccount) {
      if (message.isMention) {
        if (firstTimeForAccount(message)) {
          await answerMention({ asUserAccount, message, thread });
        }
        return;
      }
      await answerAsAccount({ message, thread });
      return;
    }
    await Promise.all([
      answerThreadMessage({ asUserAccount, message, thread }),
      answerAsAccount({ message, thread }),
    ]);
  });
}

// A mention, or a top-level message in a code channel (which is answered as if
// it were one): the same gates either way — bans, opt-in, focus, the bot loop.
async function answerMention({
  asUserAccount,
  message,
  thread,
}: {
  asUserAccount: boolean;
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (shouldIgnore(message)) {
    return;
  }
  const fromBot = message.author.isBot === true;
  if (fromBot && !allowBotTurn(thread.id)) {
    logger.info(
      { botId: message.author.userId, threadId: thread.id },
      '[bots] ignored a bot mention: too many bot turns in a row here'
    );
    return;
  }
  if (!fromBot) {
    noteHumanMessage(thread.id);
  }
  // Focus mode: in a focused thread, ignore mentions from non-focused users so
  // they can't hijack kyto away from the people it was told to attend to.
  if (!isFocusAllowed(await thread.state, message.author.userId)) {
    return;
  }
  if (await refuseBanned(thread, message)) {
    return;
  }
  // A bot cannot click "i accept", so the opt-in gate is a person's; a bot is
  // still subject to bans, and to the loop guard above.
  if (!(fromBot || (await isUserAllowed(message.author.userId)))) {
    await offerOptInAs({ asUserAccount, message, thread });
    return;
  }
  // Mentioned anywhere in a thread — its top or halfway down — stay for the
  // replies, as whichever kyto was pinged: the last one pinged takes the
  // thread over, so it never gets an answer from both. Not for a bot —
  // joining would have kyto answering a thread nobody human asked it into.
  if (!fromBot) {
    await thread.setState({
      respondAs: asUserAccount ? 'user' : 'app',
      respondOnThreadMessages: true,
    });
  }
  await runCommandOrTurn({ asUserAccount, message, thread });
}

async function answerThreadMessage({
  asUserAccount,
  message,
  thread,
}: {
  asUserAccount: boolean;
  message: Message;
  thread: Thread;
}): Promise<void> {
  // A code channel: every top-level message from a person is for kyto (the
  // app — the user account is not a code channel's bot). Bots still need an
  // explicit mention there (lib/bot-pings).
  const { channel, threadTs } = slack.decodeThreadId(message.threadId);
  if (
    !asUserAccount &&
    message.author.isBot !== true &&
    threadTs === message.id &&
    (await isCodeChannel(channel))
  ) {
    await answerMention({ asUserAccount, message, thread });
    return;
  }
  // Pinging the OTHER kyto is talking to it, not to this one — both
  // connections see the message, and the pinged one answers it.
  const otherId = asUserAccount ? slack.botUserId : slack.userAccountId;
  if (
    !message.isMention &&
    otherId &&
    (rawSlackText(message) ?? '').includes(`<@${otherId}>`)
  ) {
    return;
  }
  const state = await thread.state;
  const shouldRespondToThread =
    state?.respondOnThreadMessages === true &&
    (state.respondAs ?? 'app') === (asUserAccount ? 'user' : 'app');

  if (shouldIgnore(message)) {
    return;
  }
  const fromBot = message.author.isBot === true;
  if (!fromBot) {
    noteHumanMessage(thread.id);
  }
  if (
    !(
      (shouldRespondToThread || message.isMention) &&
      isFocusAllowed(state, message.author.userId)
    ) ||
    (await activeBan(message.author.userId)) !== null ||
    !(fromBot || (await isUserAllowed(message.author.userId)))
  ) {
    return;
  }
  if (fromBot && !allowBotTurn(thread.id)) {
    logger.info(
      { botId: message.author.userId, threadId: thread.id },
      '[bots] ignored a bot mention: too many bot turns in a row here'
    );
    return;
  }
  await runCommandOrTurn({ asUserAccount, message, thread });
}

/**
 * The opt-in prompt carries buttons, which only the app can post. The user
 * account (often in a DM the app is not part of) says it in words instead.
 */
async function offerOptInAs({
  asUserAccount,
  message,
  thread,
}: {
  asUserAccount: boolean;
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (!asUserAccount) {
    await offerOptIn(thread, message.author);
    return;
  }
  if (!env.OPT_IN_CHANNEL) {
    return;
  }
  await thread
    .post({
      fromUserAccount: true,
      markdown: `hey! you'll need to accept the terms in <#${env.OPT_IN_CHANNEL}> first, then ping me again`,
    })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), threadId: thread.id },
        '[user-account] could not point someone at the opt-in'
      );
    });
}

// `/kyto ban @someone 1d reason`, `/kyto unban @someone`, `/kyto bans`. The
// same three run as `@kyto!ban …` (lib/commands); this is the form the owner
// asked for, and it costs no model turn either.
bot.onSlashCommand(async ({ text, userId }) => {
  const [word = '', ...rest] = text.trim().split(/\s+/);
  const action = word.toLowerCase();
  if (action === 'ban' || action === 'unban' || action === 'bans') {
    return await runBanCommand({ action, args: rest.join(' '), userId });
  }
  return;
});

bot.onAction([OPT_IN_ACCEPT_ACTION, OPT_IN_NO_JOIN_ACTION], acceptOptIn);

bot.onAction('stop_turn', async (event) => {
  const threadId = event.value ?? event.threadId;
  const stopped = stopTurn({ threadId });

  if (!stopped) {
    await event.thread
      ?.postEphemeral(event.user, 'no active response to stop.', {
        fallbackToDM: false,
      })
      .catch((error: unknown) => {
        logger.warn(
          {
            ...toLogError(error),
            threadId,
            userId: event.user.userId,
          },
          'Failed to post stop feedback'
        );
      });
  }
});

async function runCommandOrTurn({
  asUserAccount,
  message,
  thread,
}: {
  asUserAccount: boolean;
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (await handleCommand({ message, thread })) {
    return;
  }
  // `!secret` DOES cost a turn (it is a real question), but its plumbing is
  // different enough — message deleted first, answer ephemeral, nothing
  // persisted — to sit beside the no-turn commands rather than inside runTurn.
  if (await handleSecret({ message, thread })) {
    return;
  }
  await runTurn({ asUserAccount, message, thread });
}

/**
 * A banned person gets one ephemeral saying so, and nothing else — no turn, no
 * opt-in prompt, no reply. Ephemeral rather than a public reply so a ban is not
 * announced to the channel every time they type.
 */
async function refuseBanned(
  thread: Thread,
  message: Message
): Promise<boolean> {
  const ban = await activeBan(message.author.userId);
  if (!ban) {
    return false;
  }
  logger.info(
    { threadId: thread.id, userId: message.author.userId },
    '[bans] ignored a banned user'
  );
  await thread
    .postEphemeral(message.author, banNotice(ban), { fallbackToDM: false })
    .catch((error: unknown) => {
      logger.warn(
        { ...toLogError(error), userId: message.author.userId },
        '[bans] could not tell them they are banned'
      );
    });
  return true;
}

function shouldIgnore(message: Message): boolean {
  if (message.author.userId === 'USLACKBOT' || message.author.isMe === true) {
    return true;
  }
  // Another bot is answered only when it @mentions kyto (lib/bot-pings) —
  // never just for talking in a thread kyto joined, and never in a DM.
  if (message.author.isBot === true && !message.isMention) {
    return true;
  }
  // `<>` at the front means "only the agents named here should answer". Applied
  // uniformly, DMs included (owner's call, 2026-08-07: whichever is simpler) —
  // one rule to explain, and in a DM it is still the sender saying "not you".
  if (isAddressedOnly(message) && !message.isMention) {
    return true;
  }

  return isHiddenFromBot(message);
}
