import {
  addCodeChannel,
  type CodeChannel,
  listCodeChannels,
  removeCodeChannel,
} from '@repo/db/queries';

// Code channels (owner's ask, 2026-09-29, after coolton's). In one, kyto answers
// every TOP-LEVEL message without being mentioned — each in its own thread, as
// everywhere else (Slack streams only into a thread) — and every thread in the
// channel shares ONE sandbox, so code written in one thread is there in the
// next. A thread inside it still works like any thread kyto is in.
//
// Checked on every non-mention channel message, so the set is held in memory
// and loaded once; this process is the only writer.

let cache: Promise<Map<string, CodeChannel>> | undefined;

function channels(): Promise<Map<string, CodeChannel>> {
  cache ??= listCodeChannels()
    .then((rows) => new Map(rows.map((row) => [row.channelId, row])))
    .catch((error: unknown) => {
      cache = undefined;
      throw error;
    });
  return cache;
}

export async function getCodeChannel(
  channelId: string
): Promise<CodeChannel | undefined> {
  return (await channels()).get(channelId);
}

export async function isCodeChannel(channelId: string): Promise<boolean> {
  return (await channels().catch(() => new Map())).has(channelId);
}

export async function allCodeChannels(): Promise<CodeChannel[]> {
  return [...(await channels()).values()];
}

export async function enableCodeChannel({
  channelId,
  enabledBy,
}: {
  channelId: string;
  enabledBy: string;
}): Promise<void> {
  await addCodeChannel({ channelId, enabledBy });
  const map = await channels();
  if (!map.has(channelId)) {
    map.set(channelId, { channelId, enabledAt: new Date(), enabledBy });
  }
}

export async function disableCodeChannel(channelId: string): Promise<boolean> {
  const removed = await removeCodeChannel(channelId);
  (await channels()).delete(channelId);
  return removed;
}

/**
 * The key a turn's sandbox is remembered under: the CHANNEL in a code channel,
 * so its threads share one workspace, else the thread.
 */
export async function sandboxKey(threadId: string): Promise<string> {
  const [platform, channelId] = threadId.split(':');
  if (platform === 'slack' && channelId && (await isCodeChannel(channelId))) {
    return `slack:${channelId}`;
  }
  return threadId;
}
