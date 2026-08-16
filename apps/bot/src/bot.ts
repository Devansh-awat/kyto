import type { Message, ThreadHandle as Thread } from '@/harness';
import { runTurn, stopTurn } from '@/lib/agent';
import { isFocusAllowed } from '@/lib/agent/focus';
import { isUserAllowed } from '@/lib/allowed-users';
import { activeBan, banNotice, runBanCommand } from '@/lib/bans';
import { bot, slack } from '@/lib/chat';
import { handleCommand } from '@/lib/commands';
import logger from '@/lib/logger';
import { acceptOptIn, offerOptIn } from '@/lib/onboarding';
import { handleSecret } from '@/lib/secret';
import { toLogError } from '@/lib/utils/error';
import { isAddressedOnly, isHiddenFromBot } from '@/lib/utils/message';
import '@/features/approvals';
import '@/features/ask-question';
import '@/features/assistant';
import '@/features/confirm-post';
import '@/features/customizations';
import '@/features/mcp-permissions';
import '@/features/poll';

export { bot } from '@/lib/chat';

bot.onNewMention(async (thread, message) => {
  if (shouldIgnore(message)) {
    return;
  }
  // Focus mode: in a focused thread, ignore mentions from non-focused users so
  // they can't hijack kyto away from the people it was told to attend to.
  if (!isFocusAllowed(await thread.state, message.author.userId)) {
    return;
  }
  if (await refuseBanned(thread, message)) {
    return;
  }
  if (!(await isUserAllowed(message.author.userId))) {
    await offerOptIn(thread, message.author);
    return;
  }
  if (slack.decodeThreadId(message.threadId).threadTs === message.id) {
    await thread.setState({ respondOnThreadMessages: true });
    await thread.subscribe();
  }
  await runCommandOrTurn(thread, message);
});

bot.onDirectMessage(async (thread, message) => {
  if (shouldIgnore(message)) {
    return;
  }
  if (await refuseBanned(thread, message)) {
    return;
  }
  if (!(await isUserAllowed(message.author.userId))) {
    await offerOptIn(thread, message.author);
    return;
  }
  await thread.subscribe();
  await runCommandOrTurn(thread, message);
});

bot.onSubscribedMessage(async (thread, message) => {
  const state = await thread.state;
  const shouldRespondToThread =
    state &&
    typeof state === 'object' &&
    'respondOnThreadMessages' in state &&
    state.respondOnThreadMessages === true;

  if (
    shouldIgnore(message) ||
    !(shouldRespondToThread || message.isMention) ||
    !isFocusAllowed(state, message.author.userId) ||
    (await activeBan(message.author.userId)) !== null ||
    !(await isUserAllowed(message.author.userId))
  ) {
    return;
  }
  await runCommandOrTurn(thread, message);
});

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

bot.onAction('opt_in_accept', acceptOptIn);

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

async function runCommandOrTurn(
  thread: Thread,
  message: Message
): Promise<void> {
  if (await handleCommand({ message, thread })) {
    return;
  }
  // `!secret` DOES cost a turn (it is a real question), but its plumbing is
  // different enough — message deleted first, answer ephemeral, nothing
  // persisted — to sit beside the no-turn commands rather than inside runTurn.
  if (await handleSecret({ message, thread })) {
    return;
  }
  await runTurn({ message, thread });
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
  if (
    message.author.isBot === true ||
    message.author.userId === 'USLACKBOT' ||
    message.author.isMe === true
  ) {
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
