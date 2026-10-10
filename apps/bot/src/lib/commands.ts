import { removeOptIn } from '@repo/db/queries';
import { env } from '@/env';
import type { ThreadHandle as Thread } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { stopTurn } from '@/lib/agent';
import {
  hasOwnModels,
  isReasoningEffort,
  isSharedModel,
  MODEL_CHOICES,
  type ReasoningEffort,
  updateThreadModelChoice,
} from '@/lib/agent/model-choice';
import { removeAllowedUser } from '@/lib/allowed-users';
import { runBanCommand } from '@/lib/bans';
import { type ParsedFlags, parseFlags } from '@/lib/flags';
import logger from '@/lib/logger';
import { toLogError } from '@/lib/utils/error';
import { rawText, withoutLeadingMentions } from '@/lib/utils/message';

// Commands the HARNESS answers itself, before any model turn exists.
//
// Written `@kyto!focusmode @someone` (owner's ask, 2026-08-05; he typed `?` the
// first time and corrected it to `!` on 2026-08-07) — the mention is how you
// address kyto in a channel, and the command rides straight off it with no
// space, which is why `withoutLeadingMentions` leaves the `!…` behind.
//
// `!` is the ONLY prefix. `?` was accepted briefly and is gone: a message that
// opens with a question mark is far more often a real question than a command,
// and one prefix is one thing to remember.
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
  type: 'ban' | 'bans' | 'focusmode' | 'optout' | 'stop' | 'unban';
}

// Slack user ids look like U0123ABCD / W0123ABCD, either as a real `<@U…>`
// mention or pasted bare. Only proper mentions are documented (the owner asked
// for "proper mentions"); a bare id is accepted because it costs nothing and a
// pasted id is otherwise silently dropped.
const MENTIONED_USER =
  /<@([UW][A-Z0-9]{6,})(?:\|[^>]+)?>|\b([UW][A-Z0-9]{6,})\b/g;
const CLEAR_WORDS = new Set(['clear', 'off', 'none', 'stop']);
// `none` is a real effort, so it can't clear `--reasoning`.
const DEFAULT_WORDS = new Set(['default', 'random', 'reset', 'clear', 'off']);
// What a `--model` slug may look like (`openai/gpt-5.1`, `claude-sonnet-4-5@x`).
const MODEL_SLUG = /^[\w.:/@-]{1,200}$/;

export async function handleCommand({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<boolean> {
  const parsed = parseFlags(withoutLeadingMentions(rawText(message)));
  if (parsed) {
    return await runFlags({ message, parsed, thread });
  }
  const command = cmd(message);
  if (!command) {
    return false;
  }
  if (command.type === 'stop') {
    await runStop({ message, thread });
    return true;
  }
  if (command.type === 'optout') {
    await runOptOut({ message, thread });
    return true;
  }
  if (
    command.type === 'ban' ||
    command.type === 'unban' ||
    command.type === 'bans'
  ) {
    // Same implementation as `/kyto ban …`, and owner-only inside it.
    const text = await runBanCommand({
      action: command.type,
      args: command.args,
      userId: message.author.userId,
    });
    await tell({ message, text, thread, what: 'ban feedback' });
    return true;
  }
  await runFocusMode({ args: command.args, message, thread });
  return true;
}

/**
 * `!optout` — withdraw acceptance of the terms. The way out for someone who
 * opted in WITHOUT joining the channel, who otherwise has no leave button; a
 * channel member is told that leaving is part of it, since membership is itself
 * the acceptance and is re-read at every restart.
 */
async function runOptOut({
  message,
  thread,
}: {
  message: Message;
  thread: Thread;
}): Promise<void> {
  if (!env.OPT_IN_CHANNEL) {
    await tell({
      message,
      text: "there's no opt-in here, so there's nothing to opt out of.",
      thread,
      what: 'opt-out feedback',
    });
    return;
  }
  const userId = message.author.userId;
  await removeOptIn(userId).catch((error: unknown) => {
    logger.warn(
      { ...toLogError(error), userId },
      '[commands] could not remove an opt-in'
    );
  });
  await removeAllowedUser(userId);
  logger.info({ userId }, '[commands] user opted out');
  await tell({
    message,
    text: `you're opted out — i won't answer you until you opt in again. if you're a member of <#${env.OPT_IN_CHANNEL}>, leave it too: being in that channel counts as opting in.`,
    thread,
    what: 'opt-out feedback',
  });
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
 * `--model`, `--reasoning`, `--focusmode` (lib/flags). Everything is checked
 * before anything is saved, so one bad flag changes nothing.
 *
 * `--model luna|haiku` is open to anyone (both are on kyto's cheap Hack Club
 * key); any other slug only for someone with their own key or ChatGPT account,
 * and it then runs on their turns only (lib/agent/model-choice).
 *
 * Returns false when a question follows the flags, so that message still gets
 * its turn — already on the new settings.
 */
async function runFlags({
  message,
  parsed,
  thread,
}: {
  message: Message;
  parsed: ParsedFlags;
  thread: Thread;
}): Promise<boolean> {
  const reply = async (text: string): Promise<boolean> => {
    await tell({ message, text, thread, what: 'flag feedback' });
    return true;
  };
  if (!parsed.ok) {
    return await reply(parsed.error);
  }
  const { flags } = parsed;
  const userId = message.author.userId;
  const change: { effort?: ReasoningEffort | null; model?: string | null } = {};
  const said: string[] = [];
  if (flags.model !== undefined) {
    const lower = flags.model.toLowerCase();
    if (DEFAULT_WORDS.has(lower)) {
      change.model = null;
      said.push('back on the default model');
    } else if (isSharedModel(lower)) {
      change.model = lower;
      said.push(`model ${lower}`);
    } else if (!MODEL_SLUG.test(flags.model)) {
      return await reply(`\`${flags.model}\` doesn't look like a model slug.`);
    } else if (await hasOwnModels(userId).catch(() => false)) {
      change.model = flags.model;
      said.push(`model ${flags.model}, on your own key (only your messages)`);
    } else {
      return await reply(
        `on kyto's models it's \`--model ${Object.keys(MODEL_CHOICES).join('|')}\`. any other slug needs your own key or ChatGPT account (App Home → Models).`
      );
    }
  }
  if (flags.reasoning !== undefined) {
    const lower = flags.reasoning.toLowerCase();
    if (DEFAULT_WORDS.has(lower)) {
      change.effort = null;
      said.push('default reasoning (random for haiku and luna)');
    } else if (isReasoningEffort(lower)) {
      change.effort = lower;
      said.push(`${lower} reasoning`);
    } else {
      return await reply(
        '`--reasoning none|low|medium|high`, or `--reasoning default`.'
      );
    }
  }
  try {
    if (change.model !== undefined || change.effort !== undefined) {
      await updateThreadModelChoice({ change, threadId: thread.id, userId });
    }
    if (flags.focus !== undefined) {
      const focus =
        flags.focus && flags.focus.length === 0 ? [userId] : flags.focus;
      await thread.setFocus(focus);
      said.push(
        focus
          ? `focus on ${focus.map((id) => `<@${id}>`).join(', ')}`
          : 'focus mode off'
      );
    }
  } catch (error) {
    logger.warn(
      { ...toLogError(error), threadId: thread.id },
      '[commands] could not apply flags'
    );
    return await reply("couldn't save that, try again in a moment.");
  }
  logger.info(
    { change, focus: flags.focus, threadId: thread.id, userId },
    '[commands] flags applied'
  );
  if (flags.rest) {
    return false;
  }
  return await reply(`this thread now: ${said.join('; ')}.`);
}

/**
 * `!focusmode @a @b` — restrict this thread to those people; `!focusmode off`
 * lifts it; `!focusmode` on its own focuses the person who typed it.
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
  // "@kyto!focusmode" with nobody named means the obvious thing: focus on me.
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
    text: `focus mode on — in this thread i’ll only respond to ${who}. \`!focusmode off\` to clear.`,
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

  const match = body.match(/^!(\w+)\b(.*)$/is);
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
    case 'ban':
      return { args, type: 'ban' };
    case 'unban':
      return { args, type: 'unban' };
    case 'bans':
      return { args, type: 'bans' };
    case 'optout':
      return { args, type: 'optout' };
    // Anything else is not a command and must still reach the model — `!` opens
    // plenty of ordinary sentences too.
    default:
      return null;
  }
}
