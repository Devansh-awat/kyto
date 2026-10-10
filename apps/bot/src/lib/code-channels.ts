import {
  addCodeChannel,
  type CodeChannel,
  listCodeChannels,
  removeCodeChannel,
  setCodeChannelCanvasViews,
} from '@repo/db/queries';
import { z } from 'zod';

// Code channels: kyto answers every message in one without being mentioned,
// and the whole channel shares ONE sandbox, so code written earlier is still
// there. Two kinds:
//
// - NATIVE: a real Slack code channel with kyto (the app) as its agent. Slack
//   designs one as a single session — one channel per task, replies at the top
//   level, never a separate session per thread — so the whole channel is ONE
//   conversation (thread id `slack:C…`, no ts; the harness builds top-level
//   messages that way through `isChannelConversation`). A thread someone
//   starts in it is answered in that thread.
// - ORDINARY: a plain channel someone turned on, where each top-level message
//   gets its own thread (Slack streams only into a thread outside a code
//   channel), as before native ones existed.
//
// Checked on every channel message — synchronously, while a message is built —
// so the set is held in memory, loaded at boot; this process is the only
// writer.

let loaded: Map<string, CodeChannel> | undefined;
let loading: Promise<Map<string, CodeChannel>> | undefined;

function channels(): Promise<Map<string, CodeChannel>> {
  if (loaded) {
    return Promise.resolve(loaded);
  }
  loading ??= listCodeChannels()
    .then((rows) => {
      loaded = new Map(rows.map((row) => [row.channelId, row]));
      return loaded;
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

/** Load the set before the first message arrives (index.ts, at boot). */
export async function loadCodeChannels(): Promise<void> {
  await channels();
}

/** Accepts a raw channel id or a `slack:C…[:ts]` thread id. */
function rawChannelId(channelOrThreadId: string): string {
  return channelOrThreadId.startsWith('slack:')
    ? (channelOrThreadId.split(':')[1] ?? '')
    : channelOrThreadId;
}

export async function getCodeChannel(
  channelId: string
): Promise<CodeChannel | undefined> {
  return (await channels()).get(rawChannelId(channelId));
}

export async function isCodeChannel(channelId: string): Promise<boolean> {
  return (await channels().catch(() => new Map<string, CodeChannel>())).has(
    rawChannelId(channelId)
  );
}

/**
 * Synchronous, for building a message: false until the set has loaded (a
 * message in the first seconds after boot is answered as an ordinary one).
 */
export function isNativeCodeChannel(channelId: string): boolean {
  return knownCodeChannel(channelId)?.native === true;
}

/** Synchronous lookup; undefined until the set has loaded. */
export function knownCodeChannel(channelId: string): CodeChannel | undefined {
  return loaded?.get(rawChannelId(channelId));
}

export async function allCodeChannels(): Promise<CodeChannel[]> {
  return [...(await channels()).values()];
}

export async function enableCodeChannel({
  channelId,
  enabledBy,
  native = false,
  originThreadId,
}: {
  channelId: string;
  enabledBy: string;
  native?: boolean;
  originThreadId?: string;
}): Promise<CodeChannel> {
  const row = await addCodeChannel({
    channelId,
    enabledBy,
    native,
    ...(originThreadId ? { originThreadId } : {}),
  });
  (await channels()).set(channelId, row);
  return row;
}

export async function disableCodeChannel(channelId: string): Promise<boolean> {
  const removed = await removeCodeChannel(channelId);
  (await channels()).delete(channelId);
  return removed;
}

const canvasViewsSchema = z.record(
  z.string(),
  z.object({ canvasId: z.string(), name: z.string(), viewId: z.string() })
);
export type CanvasViews = z.infer<typeof canvasViewsSchema>;

export async function canvasViews(channelId: string): Promise<CanvasViews> {
  const parsed = canvasViewsSchema.safeParse(
    (await getCodeChannel(channelId))?.canvasViews ?? {}
  );
  return parsed.success ? parsed.data : {};
}

export async function rememberCanvasView({
  channelId,
  key,
  view,
}: {
  channelId: string;
  key: string;
  view: CanvasViews[string];
}): Promise<void> {
  const next = { ...(await canvasViews(channelId)), [key]: view };
  await setCodeChannelCanvasViews({ canvasViews: next, channelId });
  const row = (await channels()).get(channelId);
  if (row) {
    row.canvasViews = next;
  }
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
