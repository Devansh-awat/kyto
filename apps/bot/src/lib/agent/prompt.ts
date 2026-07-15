import {
  type Message,
  mrkdwnToMarkdown,
  type ThreadHandle as Thread,
} from '@/harness';
import { isFocusAllowed } from '@/lib/agent/focus';
import { annotateMentions } from '@/lib/agent/mentions';
import { recallThinking, renderThinking } from '@/lib/agent/thinking';
import { slack } from '@/lib/chat';
import { isHiddenFromBot, rawSlackText } from '@/lib/utils/message';

// We never persist a session, so the whole Slack thread is the agent's only
// memory. Cap how many prior messages we replay to bound prompt size.
const MAX_THREAD_MESSAGES = 100;
// The bot's Slack username is a leftover gorkie-era handle; label its own
// authored messages as kyto so it doesn't think "gorkie" spoke (mirrors the
// same special-case in annotateMentions).
const BOT_NAME = 'kyto';

function authorLabel(message: Message): string {
  if (slack.botUserId && message.author.userId === slack.botUserId) {
    return BOT_NAME;
  }
  return message.author.userName;
}

async function renderMessage(message: Message): Promise<string> {
  const slackText = rawSlackText(message);
  const text = slackText
    ? mrkdwnToMarkdown(await annotateMentions(slackText))
    : message.text;
  return `@${authorLabel(message)} (${message.author.userId}): ${text}`;
}

export async function buildPrompt(
  message: Message,
  {
    customizationPrompt,
    thread,
  }: {
    customizationPrompt?: string;
    thread?: Thread;
  } = {}
): Promise<string> {
  const current = await renderMessage(message);

  // What kyto was THINKING on this thread's last few turns. Slack replayed above
  // only records what it said, so without this each turn re-derives the reasoning
  // (and the dead ends) of the one before it.
  const thinking = thread
    ? renderThinking(await recallThinking(thread.id))
    : '';

  let history = '';
  if (thread) {
    // Focus mode: drop messages from non-focused users so kyto genuinely never
    // sees what other people said in a focused thread (not just declines to
    // reply). Its own messages and the owner's are always kept.
    const focusState = await thread.state.catch(() => null);
    const fetched = await slack
      .fetchMessages(thread.id, { limit: MAX_THREAD_MESSAGES })
      .catch(() => undefined);
    const prior = (fetched?.messages ?? []).filter(
      (entry): entry is Message =>
        entry.id !== message.id &&
        !isHiddenFromBot(entry) &&
        isFocusAllowed(focusState, entry.author.userId, {
          isMe: entry.author.isMe === true,
        })
    );
    if (prior.length > 0) {
      const rendered = await Promise.all(prior.map(renderMessage));
      history = [
        'Conversation so far in this Slack thread (oldest first):',
        ...rendered,
        '',
        'The latest message, which you must respond to:',
      ].join('\n');
    }
  }

  const conversation = history ? `${history}\n${current}` : current;
  const body = thinking ? `${thinking}\n\n${conversation}` : conversation;

  return customizationPrompt
    ? [
        '<user_instructions>',
        customizationPrompt,
        '</user_instructions>',
        '',
        body,
      ].join('\n')
    : body;
}
