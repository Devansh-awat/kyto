import { z } from 'zod';
import {
  createFenceNormalizer,
  disambiguateBareUrls,
  healMarkdown,
  neutralizeBroadcast,
  restoreAnnotatedMentions,
} from '@/harness/markdown';
import type { ThreadHandle as Thread } from '@/harness/thread';
import { stripLeakedToolName } from '@/lib/agent/leaked-tool-name';
import { slack } from '@/lib/chat';
import { resolveIdentity } from '@/lib/identity';
import logger from '@/lib/logger';
import { linkChannelNames } from '@/lib/slack/channel-links';

// Reply text reaches Slack two ways. The app's turns STREAM it into the turn's
// own messages (see streamSegmented): `release` hands over whole lines as they
// come and `endMessage` closes a code block left open when a message ends. The
// user account cannot stream, so its replies are POSTED by `flush` — one
// message per run of text, cut only past Slack's limit. Each cut used to be
// made at every blank line as the text streamed in, which put one reply into
// several messages and a code block into a message of its own (#78).
//
// Slack's markdown block caps text at 12k characters.
const MAX_POST = 11_000;
// A streamed message is cut a little earlier: its text arrives in pieces, so
// the closing fence still has to fit after the cut.
const MAX_STREAMED = 10_000;
// Held back until there is this much or the model goes quiet: a degenerate
// loop is caught within a few short lines and a bare `skip` is one word, and
// both are dropped from the buffer before Slack sees them.
const MIN_CHUNK = 280;
const SOFT_FLUSH = 900;
const IDLE_MS = 1500;
const FENCE_REOPEN_PADDING = 3;
const TABLE_SEPARATOR = /^\|?[\s:|-]*-{2,}[\s:|-]*$/;

// A PRIVATE channel the app isn't in answers `channel_not_found`, not
// `not_in_channel` — the reply to a ping of the user account there was lost
// the same way (issue #13).
const OUTSIDE_CHANNEL = new Set(['channel_not_found', 'not_in_channel']);
const slackErrorSchema = z.looseObject({
  data: z.looseObject({ error: z.string().optional() }).optional(),
});

function isNotInChannel(error: unknown): boolean {
  const code = slackErrorSchema.safeParse(error).data?.data?.error;
  return code !== undefined && OUTSIDE_CHANNEL.has(code);
}

export function createReply({
  allowBroadcast = false,
  fromUserAccount = false,
  threadId,
}: {
  // Only the owner may make kyto ping @channel/@here/@everyone; for everyone
  // else broadcast tokens are downgraded to inert plaintext before posting.
  allowBroadcast?: boolean;
  /** Posted by kyto's Slack user account, which has no custom icon. */
  fromUserAccount?: boolean;
  threadId: string;
}) {
  // What the model wrote and nobody has seen yet.
  let buffer = '';
  let lastReleaseAt = Date.now();
  let posted = false;
  const fences = createFenceNormalizer({ slack: false });
  // The streamed message being written: its text so far, and the fence a cut
  // closed, to reopen at the top of the next one.
  let streamed = '';
  let reopenFence: string | null = null;

  // Take `raw` off the front of the buffer with its fences normalized. Only
  // ever whole lines, except for the end of the text.
  function takeLines(index: number): string {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index);
    return raw
      .split('\n')
      .map((line) => fences.line(line))
      .join('\n');
  }

  function sanitize(text: string): string {
    // restoreAnnotatedMentions first: the model writes mentions in the
    // annotated form it was SHOWN (`@name (Uxxx)`), which Slack renders as inert
    // text. Turning it back into `<@Uxxx>` here is what makes a mention ping.
    // Broadcast neutralization still runs after, so this cannot smuggle one in
    // (it only ever produces `<@ID>`, never a `<!channel>` control token).
    // …and the same for channels: the model writes `#some-channel` because
    // that is how channels read everywhere else, and Slack renders that as
    // plain text. Resolved off the cached name→id index; an unknown name is
    // left exactly as written. Channels only — a person or user group is never
    // auto-resolved, because guessing which `@name` is whom is how you ping the
    // wrong person or a whole group nobody asked for.
    const restored = linkChannelNames(restoreAnnotatedMentions(text));
    return allowBroadcast ? restored : neutralizeBroadcast(restored);
  }

  async function postChunks({
    text,
    thread,
  }: {
    text: string;
    thread: Thread;
  }): Promise<void> {
    let rest = text;
    while (rest.trim()) {
      const index =
        rest.length > MAX_POST ? hardCut(rest.slice(0, MAX_POST)) : rest.length;
      const { chunk, remainder } = cutChunk({ index, text: rest });
      rest = remainder;
      const markdown = healMarkdown(sanitize(chunk)).trim();
      if (!markdown) {
        continue;
      }
      // The normal identity profile can restyle kyto's avatar on ordinary
      // replies — icon only, the name stays plain "kyto". Cached 30s, and it
      // never throws (resolveIdentity swallows load errors).
      const identity = fromUserAccount
        ? { fromUserAccount }
        : await resolveIdentity('normal');
      try {
        // `post` denies broadcasts by default; the owner's reply is one of the
        // two paths allowed to opt in (this thread IS the channel kyto was
        // invoked in). `sanitize` has already neutralized the chunk when
        // allowBroadcast is false, so this is belt and braces either way.
        await thread.post({ allowBroadcast, ...identity, markdown });
        posted = true;
      } catch (error) {
        // The turn archived its own channel (a code channel closed on request,
        // issue #69): nothing can be posted there any more, so drop the rest
        // instead of failing every remaining chunk.
        if (
          slackErrorSchema.safeParse(error).data?.data?.error === 'is_archived'
        ) {
          logger.info({ threadId }, '[agent] channel archived; reply dropped');
          return;
        }
        if (fromUserAccount || !isNotInChannel(error)) {
          logger.warn({ err: error, threadId }, '[agent] reply post failed');
          continue;
        }
        await postOutsideChannel({ chunk: markdown, identity, thread });
      }
    }
  }

  // The app was asked in a channel it isn't in (the user account heard it):
  // Slack refused the reply and it vanished while the turn logged complete.
  // Join (public channels) and retry; failing that, send it from kyto's user
  // account, which is in the channel if it heard the message.
  async function postOutsideChannel({
    chunk,
    identity,
    thread,
  }: {
    chunk: string;
    identity:
      | Awaited<ReturnType<typeof resolveIdentity>>
      | { fromUserAccount: true };
    thread: Thread;
  }): Promise<void> {
    const channel = threadId.split(':')[1] ?? '';
    try {
      await slack.webClient.conversations.join({ channel });
      await thread.post({ allowBroadcast, ...identity, markdown: chunk });
      posted = true;
      return;
    } catch (error) {
      logger.error(
        { channel, err: error, threadId },
        '[agent] reply refused (not in the channel) and joining did not help; trying the user account'
      );
    }
    if (!slack.userAccountId) {
      return;
    }
    try {
      await thread.post({ fromUserAccount: true, markdown: chunk });
      posted = true;
    } catch (error) {
      logger.error(
        { channel, err: error, threadId },
        '[agent] reply lost: neither the app nor the user account could post'
      );
    }
  }

  return {
    append(text: string): void {
      buffer += text;
    },
    // Throw away everything still buffered, i.e. everything not yet posted. Used
    // when an attempt degenerates into a token loop: the loop is caught within a
    // few short lines, which is well under the release thresholds above, so this
    // is what actually keeps it out of the thread.
    drop(): void {
      buffer = '';
    },
    // Unbuffer just this trailing text, if it is still unposted. Used to retract
    // one attempt's output without touching an earlier attempt's — `drop()` would
    // throw away a previous model's real answer along with it. A no-op once the
    // text has already gone to Slack, which is the honest outcome: it cannot be
    // unsent, and silently reporting success would be worse.
    dropTail(text: string): boolean {
      if (!(text && buffer.endsWith(text))) {
        return false;
      }
      buffer = buffer.slice(0, -text.length);
      return true;
    },
    /**
     * Text for the streamed message, in whole lines — or all of it when
     * `force`d (a card is next, or the stream ended). Empty while it is still
     * being held back.
     */
    release({
      beforeCard = false,
      force,
    }: {
      /** A tool card is next: a bare tool name ending the text is a leak. */
      beforeCard?: boolean;
      force: boolean;
    }): string {
      let index: number;
      if (force) {
        // Only right before a card: the leak is the name of the call that
        // follows. At the END of a reply a tool name is an answer ("list
        // your tools") and stays.
        if (beforeCard) {
          buffer = stripLeakedToolName(buffer);
        }
        index = buffer.length;
      } else {
        const ready =
          buffer.length >= SOFT_FLUSH ||
          (buffer.length >= MIN_CHUNK && Date.now() - lastReleaseAt >= IDLE_MS);
        index = ready ? buffer.lastIndexOf('\n') + 1 : 0;
      }
      if (!buffer.slice(0, index).trim()) {
        return '';
      }
      let text = takeLines(index);
      lastReleaseAt = Date.now();
      // A message never opens on blank lines (the model's "\n" between tool
      // calls ends up here).
      if (!streamed) {
        text = text.replace(/^\s*\n/, '');
        if (reopenFence !== null) {
          text = `\`\`\`${reopenFence}\n${text}`;
          reopenFence = null;
        }
      }
      text = disambiguateBareUrls(sanitize(text));
      streamed += text;
      posted = true;
      return text;
    },
    /** The streamed message is long enough that the next text needs a new one. */
    streamedFull(): boolean {
      return streamed.length >= MAX_STREAMED;
    },
    /**
     * The streamed message is ending: what still has to go into it so it
     * renders whole — the close of a code block it leaves open, which is then
     * reopened at the top of the next message.
     */
    endMessage(): string {
      const fence = openFence(streamed);
      streamed = '';
      if (fence === null) {
        return '';
      }
      reopenFence = fence;
      return '\n```';
    },
    /** Post everything still buffered (the user account, or what a failed or
     * interrupted stream left behind). */
    async flush({ thread }: { thread: Thread }): Promise<void> {
      const text = takeLines(buffer.length);
      const reopened =
        reopenFence !== null && text.trim()
          ? `\`\`\`${reopenFence}\n${text}`
          : text;
      reopenFence = null;
      await postChunks({ text: reopened, thread });
    },
    /** Whether any reply text reached the thread this turn. */
    hasPosted(): boolean {
      return posted;
    },
  };
}

// Split `text` at `index` without breaking a code block or a table: an open
// fence is closed here and reopened in the remainder, a table's header row is
// repeated so the rest still renders as a table.
function cutChunk({ index, text }: { index: number; text: string }): {
  chunk: string;
  remainder: string;
} {
  const raw = text.slice(0, index);
  let remainder = text.slice(index).replace(/^\n+/, '');
  if (!remainder) {
    return { chunk: raw, remainder: '' };
  }
  const fence = openFence(raw);
  if (fence === null) {
    const header = continuedTableHeader({ chunk: raw, remainder });
    return {
      chunk: raw,
      remainder: header ? `${header}\n${remainder}` : remainder,
    };
  }
  remainder = `\`\`\`${fence}\n${remainder}`;
  return { chunk: `${raw.replace(/\s+$/, '')}\n\`\`\``, remainder };
}

function hardCut(text: string): number {
  const floor = Math.floor(text.length / FENCE_REOPEN_PADDING);
  const paragraph = text.lastIndexOf('\n\n');
  if (paragraph >= floor) {
    return paragraph + 2;
  }
  const line = text.lastIndexOf('\n');
  return line >= floor ? line + 1 : text.length;
}

function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:```|~~~)(.*)$/.exec(line);
    if (match) {
      open = open === null ? (match[1] ?? '').trim() : null;
    }
  }
  return open;
}

// When a chunk ends inside a table and the remainder continues it, return that
// table's "header + separator" rows so they can be re-prepended to the remainder.
function continuedTableHeader({
  chunk,
  remainder,
}: {
  chunk: string;
  remainder: string;
}): string | null {
  const lines = chunk.replace(/\n+$/, '').split('\n');
  const lastLine = lines.at(-1) ?? '';
  const nextLine = remainder.split('\n')[0] ?? '';
  if (!(looksLikeTableRow(lastLine) && looksLikeTableRow(nextLine))) {
    return null;
  }
  let start = lines.length;
  while (start > 0 && looksLikeTableRow(lines[start - 1] ?? '')) {
    start -= 1;
  }
  const header = lines[start];
  const separator = lines[start + 1];
  if (!(header && separator && TABLE_SEPARATOR.test(separator.trim()))) {
    return null;
  }
  const reopened = `${header}\n${separator}`;
  return remainder.startsWith(reopened) ? null : reopened;
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (TABLE_SEPARATOR.test(trimmed)) {
    return true;
  }
  return (
    trimmed.startsWith('|') || (trimmed.includes('|') && trimmed.endsWith('|'))
  );
}
