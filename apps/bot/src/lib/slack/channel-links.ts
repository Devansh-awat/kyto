import type { ChannelChangeEvent } from '@/harness/types';
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

// Every public channel in the workspace, by id — the index that links names
// AND the directory the sandbox's `slack channels` reads (#132: listing them
// through the proxy timed out, and Flaron's search stops at 10). Loaded by
// paging conversations.list at boot, kept current by Slack's channel events
// (created/renamed/archived/unarchived/deleted), and re-paged every few hours
// only as a safety net for events missed during a reconnect. Member counts are
// as of that last full page-through: no event reports them.
const REFRESH_MS = 6 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
const PURPOSE_MAX = 100;

export interface DirectoryChannel {
  created?: number;
  id: string;
  members?: number;
  name: string;
  purpose?: string;
}

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

let byId = new Map<string, DirectoryChannel>();
let index = new Map<string, string>();
let loadedAt = 0;
// False until one page-through reached the end: a directory answer says so.
let complete = false;
let inFlight: Promise<void> | undefined;
let firstPage: Promise<void> | undefined;

function toEntry(channel: {
  created?: number;
  id?: string;
  name?: string;
  num_members?: number;
  purpose?: { value?: string };
}): DirectoryChannel | undefined {
  if (!(channel.id && channel.name)) {
    return;
  }
  const purpose = channel.purpose?.value?.trim().slice(0, PURPOSE_MAX);
  return {
    id: channel.id,
    name: channel.name,
    ...(channel.created ? { created: channel.created } : {}),
    ...(channel.num_members === undefined
      ? {}
      : { members: channel.num_members }),
    ...(purpose ? { purpose } : {}),
  };
}

async function refresh(onFirstPage: () => void): Promise<void> {
  const first = byId.size === 0;
  const next = new Map<string, DirectoryChannel>();
  let cursor: string | undefined;
  do {
    const response = await slack.webClient.conversations.list({
      cursor,
      exclude_archived: true,
      limit: PAGE_LIMIT,
      types: 'public_channel',
    });
    for (const channel of response.channels ?? []) {
      const entry = toEntry(channel);
      if (entry) {
        next.set(entry.id, entry);
        // The first load is used page by page, so linking works while the
        // rest is still coming in; a refresh swaps in whole at the end.
        if (first) {
          byId.set(entry.id, entry);
          index.set(entry.name, entry.id);
        }
      }
    }
    onFirstPage();
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
  byId = next;
  index = new Map([...next.values()].map((entry) => [entry.name, entry.id]));
  loadedAt = Date.now();
  complete = true;
  logger.info({ channels: next.size }, '[slack] channel directory refreshed');
}

/**
 * Load (or refresh) the channel directory. Only the first PAGE of the first
 * load is waited on (enough to link the common names); the rest, and later
 * refreshes, run behind the caller. A refresh in flight is shared, and a
 * failure leaves the previous directory in place rather than emptying it.
 */
export function ensureChannelIndex(): Promise<void> {
  if (index.size > 0 && Date.now() - loadedAt < REFRESH_MS) {
    return Promise.resolve();
  }
  if (index.size > 0) {
    // A stale directory still links almost every name; refresh behind it.
    inFlight ??= runRefresh(() => undefined);
    return Promise.resolve();
  }
  // The whole workspace is tens of pages at Slack's list rate limit: waiting
  // on all of it held the boot (and the first turns) for a minute or more, so
  // a first load is waited on only until its first page is in.
  if (!inFlight) {
    let markFirstPage: () => void = () => undefined;
    firstPage = new Promise((resolve) => {
      markFirstPage = resolve;
    });
    inFlight = runRefresh(markFirstPage);
    inFlight.then(markFirstPage, markFirstPage);
  }
  return firstPage ?? inFlight;
}

function runRefresh(onFirstPage: () => void): Promise<void> {
  return refresh(onFirstPage)
    .catch((error: unknown) => {
      logger.warn({ err: error }, '[slack] channel directory refresh failed');
    })
    .finally(() => {
      inFlight = undefined;
    });
}

/** Keep the directory current from Slack's channel events. */
export async function applyChannelChange(
  event: ChannelChangeEvent
): Promise<void> {
  const known = byId.get(event.channelId);
  if (event.kind === 'archived' || event.kind === 'deleted') {
    if (known) {
      byId.delete(event.channelId);
      index.delete(known.name);
    }
    return;
  }
  let entry: DirectoryChannel | undefined;
  if (event.kind === 'renamed' && known && event.name) {
    index.delete(known.name);
    entry = { ...known, name: event.name };
  } else if (event.kind === 'created' && event.name) {
    entry = {
      created: Math.floor(Date.now() / 1000),
      id: event.channelId,
      members: 1,
      name: event.name,
    };
  } else {
    // An unarchive (or a rename of one we never saw) carries no details.
    const info = await slack.webClient.conversations
      .info({ channel: event.channelId })
      .catch(() => undefined);
    const channel = info?.channel;
    if (!channel || channel.is_private || channel.is_archived) {
      return;
    }
    entry = toEntry(channel);
  }
  if (entry) {
    byId.set(entry.id, entry);
    index.set(entry.name, entry.id);
  }
}

/**
 * Public channels whose name (or purpose, with `inPurpose`) contains `query`,
 * for the sandbox's `slack channels`. Public channels only — nothing here
 * needs the asker's membership — and answered from memory: no Slack call.
 */
export function searchChannelDirectory({
  inPurpose,
  limit,
  query,
}: {
  inPurpose: boolean;
  limit: number;
  query: string;
}): {
  channels: DirectoryChannel[];
  complete: boolean;
  matched: number;
  total: number;
} {
  const needle = query.trim().toLowerCase().replace(/^#/, '');
  const matches = [...byId.values()]
    .filter(
      (entry) =>
        !needle ||
        entry.name.includes(needle) ||
        (inPurpose && entry.purpose?.toLowerCase().includes(needle))
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    channels: matches.slice(0, limit),
    complete,
    matched: matches.length,
    total: byId.size,
  };
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
