import {
  type Message,
  mrkdwnToMarkdown,
  type ThreadHandle as Thread,
} from '@/harness';
import { annotateMentions } from '@/lib/agent/mentions';
import { slack } from '@/lib/chat';
import { rawSlackText } from '@/lib/utils/message';

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

  let history = '';
  if (thread) {
    const fetched = await slack
      .fetchMessages(thread.id, { limit: MAX_THREAD_MESSAGES })
      .catch(() => undefined);
    const prior = (fetched?.messages ?? []).filter(
      (entry): entry is Message => entry.id !== message.id
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

  const body = history ? `${history}\n${current}` : current;

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
