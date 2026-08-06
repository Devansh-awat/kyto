import type { Message, ThreadHandle as Thread } from '@/harness';
import { stopTurn } from '@/lib/agent';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { rawText, withoutLeadingMentions } from '@/lib/utils/message';

// Commands the HARNESS answers itself, before any model turn exists.
//
// Written `@kyto?focusmode @someone` (owner's ask, 2026-08-05) — the mention is
// how you address kyto in a channel, and the command rides straight off it with
// no space, which is why `withoutLeadingMentions` leaves the `?…` behind. `!` is
// accepted for the same set, since `!stop` predates the `?` form.
//
// The point of handling these here rather than as tools is that a command must
// NOT cost a turn and must NOT disturb one already running: `runCommandOrTurn`
// calls this first and returns as soon as it answers true, so `runTurn` is never
// entered and the in-flight turn's controller is never touched. `stop` is the
// one command that deliberately reaches into a running turn — every other one
// leaves it alone.

interface BotCommand {
  /** Everything after the command word, unparsed. */
  args: string;
  type: 'focusmode' | 'stop';
}

// Slack user ids look like U0123ABCD / W0123ABCD, either as a real `<@U…>`
// mention or pasted bare. Only proper mentions are documented (the owner asked
// for "proper mentions"); a bare id is accepted because it costs nothing and a
// pasted id is otherwise silently dropped.
const MENTIONED_USER =
  /<@([UW][A-Z0-9]{6,})(?:\|[^>]+)?>|\b([UW][A-Z0-9]{6,})\b/g;
const CLEAR_WORDS = new Set(['clear', 'off', 'none', 'stop']);

export async function handleCommand({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<boolean> {
  const command = cmd(message);
  if (!command) {
    return false;
  }
  if (command.type === 'stop') {
    await runStop({ message, thread });
    return true;
  }
  await runFocusMode({ args: command.args, message, thread });
  return true;
}

async function runStop({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (stopTurn({ threadId: thread.id })) {
    return;
  }
  await tell({
    message,
    text: 'no active response to stop.',
    thread,
    what: 'stop feedback',
  });
}

/**
 * `?focusmode @a @b` — restrict this thread to those people; `?focusmode off`
 * lifts it; `?focusmode` on its own focuses the person who typed it.
 *
 * Same state as the `focusMode` TOOL (`thread.setFocus`), so the same rules
 * apply: the owner is always exempt, and kyto's own messages always stay in
 * context. Deliberately open to anyone — the model-driven tool already is, so
 * gating the typed form would only mean asking kyto in English instead.
 */
async function runFocusMode({
  args,
  message,
  thread,
}: {
  args: string;
  message: Message;
  thread: Thread;
}): Promise<void> {
  const rest = args.trim();
  if (CLEAR_WORDS.has(rest.toLowerCase())) {
    await thread.setFocus(null);
    await tell({
      message,
      text: 'focus mode off — i’ll respond to everyone in this thread again.',
      thread,
      what: 'focus feedback',
    });
    return;
  }
  const ids = new Set<string>();
  for (const match of rest.matchAll(MENTIONED_USER)) {
    const id = match[1] ?? match[2];
    if (id) {
      ids.add(id);
    }
  }
  // "@kyto?focusmode" with nobody named means the obvious thing: focus on me.
  if (ids.size === 0) {
    ids.add(message.author.userId);
  }
  const focus = [...ids];
  await thread.setFocus(focus);
  logger.info(
    { focus, threadId: thread.id, userId: message.author.userId },
    '[commands] focus mode set'
  );
  const who = focus.map((id) => `<@${id}>`).join(', ');
  await tell({
    message,
    text: `focus mode on — in this thread i’ll only respond to ${who}. \`?focusmode off\` to clear.`,
    thread,
    what: 'focus feedback',
  });
}

// Ephemeral and never a DM: a command is a side-channel between one person and
// kyto, and a thread that just got focused is exactly the place not to add a
// visible message nobody asked for.
async function tell({
  message,
  text,
  thread,
  what,
}: {
  message: Message;
  text: string;
  thread: Thread;
  what: string;
}): Promise<void> {
  await thread
    .postEphemeral(message.author, text, { fallbackToDM: false })
    .catch((error: unknown) => {
      logger.warn(
        {
          ...toLogError(error),
          threadId: thread.id,
          userId: message.author.userId,
        },
        `Failed to post ${what}`
      );
    });
}

function cmd(message: Message): BotCommand | null {
  const body = withoutLeadingMentions(rawText(message)).trim();

  const match = body.match(/^[!?](\w+)\b(.*)$/is);
  if (!match?.[1]) {
    return null;
  }
  const args = match[2] ?? '';

  switch (match[1].toLowerCase()) {
    case 'focus':
    case 'focusmode':
      return { args, type: 'focusmode' };
    case 'stop':
      return { args, type: 'stop' };
    // Anything else is not a command — a message that merely opens with "?" is
    // an ordinary question and must still reach the model.
    default:
      return null;
  }
}
