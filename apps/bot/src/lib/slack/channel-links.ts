import { slack } from '@/lib/chat';
import logger from '@/lib/logger';

// Turning `#some-channel` in kyto's reply into a real Slack channel link.
//
// The prompt has always told the model to write `<#C0123ABCD>`, and it mostly
// doesn't: it writes the name, because that is how the name appears everywhere
// else in the conversation. Slack renders that as literal text, so "it doesn't
// link channels properly" is a formatting failure, not a knowledge one — the id
// is genuinely not available to the model for a channel it hasn't looked up.
//
// So it is resolved here instead, off a cached name→id index. Channels only:
// user and user-group mentions are deliberately NOT auto-resolved, because
// guessing which `@name` means which person is how you ping the wrong person,
// and a wrongly-resolved `@design` would ping a whole user group.

const REFRESH_MS = 30 * 60 * 1000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 5;

// Slack channel names: lowercase letters, digits, hyphens, underscores and
// periods. Anchored on a boundary so a URL fragment (`…/docs#install`) and a
// markdown heading (`# Heading`, which has a space) are both left alone.
const CHANNEL_TOKEN = /(^|[\s([{"'*_~])#([a-z0-9][a-z0-9._-]{0,78})/g;
const FENCE = /^\s*```/;
const INLINE_CODE = /`[^`]*`/g;
// Placeholder for a masked inline-code span. Uses a private-use character
// rather than spaces around an index — a space-delimited index would have
// swallowed any bare number in the line when the mask was undone.
const MASK_OPEN = '\u{E000}';
const MASK_CLOSE = '\u{E001}';
const MASKED = /\u{E000}(\d+)\u{E001}/gu;

let index = new Map<string, string>();
let loadedAt = 0;
let inFlight: Promise<void> | undefined;

async function refresh(): Promise<void> {
  const next = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await slack.webClient.conversations.list({
      cursor,
      exclude_archived: true,
      limit: PAGE_LIMIT,
      types: 'public_channel',
    });
    for (const channel of response.channels ?? []) {
      if (channel.id && channel.name) {
        next.set(channel.name, channel.id);
      }
    }
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) {
      break;
    }
  }
  index = next;
  loadedAt = Date.now();
  logger.info({ channels: next.size }, '[slack] channel name index refreshed');
}

/**
 * Load (or refresh) the channel-name index. Cheap after the first call, and
 * safe to call on every turn — a refresh in flight is shared, and a failure
 * leaves the previous index in place rather than emptying it.
 */
export function ensureChannelIndex(): Promise<void> {
  if (index.size > 0 && Date.now() - loadedAt < REFRESH_MS) {
    return Promise.resolve();
  }
  inFlight ??= refresh()
    .catch((error: unknown) => {
      logger.warn({ err: error }, '[slack] channel name index refresh failed');
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/**
 * Rewrite `#channel-name` to `<#C0123ABCD>` for every name kyto can resolve.
 * Synchronous on purpose — it runs inside the streaming reply path — so it uses
 * whatever the index holds; a name that isn't in it is left exactly as written.
 * Fenced and inline code are untouched: a `#name` in a code block is being
 * quoted, not linked.
 */
export function linkChannelNames(text: string): string {
  if (index.size === 0 || !text.includes('#')) {
    return text;
  }
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      const spans: string[] = [];
      const masked = line.replace(INLINE_CODE, (span) => {
        spans.push(span);
        return `${MASK_OPEN}${spans.length - 1}${MASK_CLOSE}`;
      });
      const linked = masked.replace(
        CHANNEL_TOKEN,
        (whole, prefix: string, name: string) => {
          const id = index.get(name);
          return id ? `${prefix}<#${id}>` : whole;
        }
      );
      return linked.replace(
        MASKED,
        (whole, i: string) => spans[Number(i)] ?? whole
      );
    })
    .join('\n');
}
