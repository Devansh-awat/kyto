import { z } from 'zod';
import type { RawSlackMessage } from './harness';

// Reading a thread is a Slack round trip of 0.3-0.7s — nearly all of it Slack's
// own server time — that used to sit between every ping and the model request.
// So each thread the prompt reads is kept here as Slack returned it, and the
// message events kyto already receives keep it current: a new message is
// added, an edit replaces, a deletion removes. A real read still runs, just not
// in front of the model: after every turn (so kyto's own streamed reply, whose
// events Slack may not send in full, is exactly what Slack holds) and behind
// every hit, which corrects the copy and logs when it had drifted.

const rawThreadRef = z.object({
  thread_ts: z.string().optional(),
  ts: z.string(),
});

// Past this, the copy is not trusted: the next read goes to Slack.
const ENTRY_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  /** Events applied since the in-flight refresh started; replayed onto it. */
  journal: RawSlackMessage[];
  oldest: string | undefined;
  raw: RawSlackMessage[];
  /** Set while a refresh is in flight, so its result knows what it missed. */
  refreshing: boolean;
}

/** `CHANNEL:THREAD_TS` — the thread a raw message or event belongs to. */
function threadKeyOf(event: RawSlackMessage): string | undefined {
  let inner: unknown = event;
  if (
    event.subtype === 'message_changed' ||
    event.subtype === 'message_replied'
  ) {
    inner = event.message;
  } else if (event.subtype === 'message_deleted') {
    inner = event.previous_message;
  }
  const parsed = rawThreadRef.safeParse(inner);
  const threadTs = parsed.success
    ? (parsed.data.thread_ts ?? parsed.data.ts)
    : undefined;
  return event.channel && threadTs ? `${event.channel}:${threadTs}` : undefined;
}

function applyEvent(
  raw: RawSlackMessage[],
  event: RawSlackMessage
): RawSlackMessage[] {
  if (event.subtype === 'message_deleted') {
    return raw.filter((entry) => entry.ts !== event.deleted_ts);
  }
  if (
    event.subtype === 'message_changed' ||
    event.subtype === 'message_replied'
  ) {
    const parsed = rawThreadRef.safeParse(event.message);
    if (!parsed.success) {
      return raw;
    }
    // The schema only checks the fields read here; the cache keeps the whole
    // message, as Slack sent it, for the harness to hydrate.
    const changed = event.message as RawSlackMessage;
    return raw.map((entry) => (entry.ts === parsed.data.ts ? changed : entry));
  }
  if (!event.ts || raw.some((entry) => entry.ts === event.ts)) {
    return raw;
  }
  // Slack ts strings are fixed-width decimals of one epoch, so they sort as
  // numbers; an event can arrive after a later one was read.
  return [...raw, event].sort((a, b) => Number(a.ts) - Number(b.ts));
}

export class ThreadCache {
  private readonly entries = new Map<string, Entry>();

  /** The thread as last read plus every event since, or undefined to read it. */
  get({
    key,
    oldest,
  }: {
    key: string;
    oldest: string | undefined;
  }): RawSlackMessage[] | undefined {
    const entry = this.entries.get(key);
    // `at` 0: a first read is still in flight, nothing is held yet.
    if (!entry || entry.at === 0 || entry.oldest !== oldest) {
      return;
    }
    if (Date.now() - entry.at > ENTRY_TTL_MS) {
      this.entries.delete(key);
      return;
    }
    return entry.raw;
  }

  /** The `oldest` the cached copy was read from, for a refresh to reuse. */
  oldestOf(key: string): { oldest: string | undefined } | undefined {
    const entry = this.entries.get(key);
    return entry ? { oldest: entry.oldest } : undefined;
  }

  /** Marks a real read as started; events from here on are replayed onto it. */
  beginRead(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.journal = [];
      entry.refreshing = true;
      return;
    }
    this.entries.set(key, {
      at: 0,
      journal: [],
      oldest: undefined,
      raw: [],
      refreshing: true,
    });
  }

  /**
   * Stores a complete read (the walk reached the newest message), replaying any
   * event that landed while it was in flight. Returns whether the copy it
   * replaces had drifted from what Slack holds, for the caller to log.
   */
  finishRead({
    key,
    oldest,
    raw,
  }: {
    key: string;
    oldest: string | undefined;
    raw: RawSlackMessage[];
  }): { drifted: boolean } {
    const previous = this.entries.get(key);
    let next = raw;
    for (const event of previous?.journal ?? []) {
      next = applyEvent(next, event);
    }
    const drifted =
      previous !== undefined &&
      previous.at > 0 &&
      previous.oldest === oldest &&
      fingerprint(previous.raw) !== fingerprint(next);
    this.entries.delete(key);
    this.entries.set(key, {
      at: Date.now(),
      journal: [],
      oldest,
      raw: next,
      refreshing: false,
    });
    const idlest = this.entries.keys().next().value;
    if (this.entries.size > MAX_ENTRIES && idlest !== undefined) {
      this.entries.delete(idlest);
    }
    return { drifted };
  }

  /** A read that failed or stopped short: the copy can't be trusted. */
  dropRead(key: string): void {
    this.entries.delete(key);
  }

  /** Every message event kyto receives, whichever thread it is in. */
  apply(event: RawSlackMessage): void {
    const key = threadKeyOf(event);
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) {
      return;
    }
    entry.raw = applyEvent(entry.raw, event);
    if (entry.refreshing) {
      entry.journal.push(event);
    }
  }

  /** Events may have been lost (a socket reconnect): trust nothing. */
  clear(): void {
    this.entries.clear();
  }
}

function fingerprint(raw: RawSlackMessage[]): string {
  return raw.map((entry) => `${entry.ts}|${entry.text ?? ''}`).join('\n');
}
