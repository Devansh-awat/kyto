import type { RequestHints } from './hints';

export function contextPrompt(hints: RequestHints): string {
  const lines = [`The current date and time is ${hints.time}.`];
  if (hints.botUserId) {
    lines.push(
      `Your own Slack user id is ${hints.botUserId}. A message that mentions <@${hints.botUserId}> (or @kyto) is addressed to YOU — never mistake it for another bot like gorkie. Never look this id up as a user.`
    );
  }
  if (hints.workspace) {
    lines.push(`The current Slack workspace is ${hints.workspace}.`);
  }
  if (hints.channel?.name) {
    lines.push(`The current channel name is ${hints.channel.name}.`);
  }
  lines.push(`The current thread id is ${hints.threadId}.`);
  if (hints.channel?.id) {
    lines.push(`The current channel id is ${hints.channel.id}.`);
  }
  if (hints.messageId) {
    lines.push(`The message you're responding to has id ${hints.messageId}.`);
  }
  lines.push(
    'When earlier conversation context matters, fetch it with host tools instead of pretending you already saw it.'
  );
  return `<context>\n${lines.join('\n')}\n</context>`;
}
