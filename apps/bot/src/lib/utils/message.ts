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

// A message is hidden from Kyto entirely (not just non-triggering) when it
// STARTS with `##` (after leading mentions). Such messages must neither wake the
// bot NOR appear in the thread context it replays — they're a private
// side-channel for humans to talk without Kyto seeing anything.
//
// Only the FIRST content line counts: a `##` further down (e.g. a normal message
// that happens to contain a markdown `## heading`) does NOT hide the message,
// which used to silently drop ordinary messages. To use the side-channel, begin
// the message with `##`.
export function isHiddenFromBot(message: Message): boolean {
  return withoutLeadingMentions(rawText(message)).trimStart().startsWith('##');
}

// Slack escapes `<`, `>` and `&` in the message text it delivers, so a person
// typing `<>` arrives as `&lt;&gt;`. Both forms are matched — the raw one
// because a message built by an API caller need not be escaped.
const ADDRESSED_ONLY = /^(?:<>|&lt;&gt;)/;

/**
 * Does this message say "only the agents I actually mentioned should answer"?
 *
 * A message that STARTS with `<>` (owner's ask, 2026-08-07) is a convention for
 * rooms with several bots in them: agents built by other people are programmed
 * to ignore such a message unless they were mentioned in it, and kyto does the
 * same. Without it, a thread kyto is subscribed to has kyto answering every
 * message, which is exactly the noise the convention exists to stop.
 *
 * Checked both at the very start and after leading mentions, so `<> @kyto do X`
 * and `@kyto <> do X` both work. It only suppresses the REPLY — the message is
 * still ordinary context kyto can see, unlike the `##` side-channel above.
 */
export function isAddressedOnly(message: Message): boolean {
  const raw = rawText(message).trimStart();
  return (
    ADDRESSED_ONLY.test(raw) ||
    ADDRESSED_ONLY.test(withoutLeadingMentions(raw).trimStart())
  );
}
