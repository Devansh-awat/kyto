import type { Message } from '@/harness';

const leadingMentions = /^\s*(?:<@[A-Z0-9][A-Z0-9._-]*(?:\|[^>]+)?>\s*)+/;

export function rawSlackText(message: Message): string | undefined {
  const raw = message.raw;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('text' in raw) ||
    typeof raw.text !== 'string'
  ) {
    return;
  }
  return raw.text;
}

export function rawText(message: Message): string {
  return rawSlackText(message) ?? message.text;
}

export function withoutLeadingMentions(text: string): string {
  return text.replace(leadingMentions, '');
}

// A message is hidden from Kyto entirely (not just non-triggering) when any of
// its lines starts with `##` after leading mentions. Such messages must neither
// wake the bot NOR appear in the thread context it replays — they're a private
// side-channel for humans to talk without Kyto seeing anything.
export function isHiddenFromBot(message: Message): boolean {
  for (const line of rawText(message).split('\n')) {
    if (withoutLeadingMentions(line).trimStart().startsWith('##')) {
      return true;
    }
  }
  return false;
}
