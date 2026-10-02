import { z } from 'zod';

// Flaron (https://flaron.halceon.dev, owner's pick 2026-10-02): a public Hack
// Club Slack directory. It knows the NAME of private channels the bot can't see
// and says outright which ones are private — the fact kyto lacked when it told
// the owner a private channel was public and joinable. Read-only, keyless.

const FLARON_URL = 'https://flaron.halceon.dev';
const TIMEOUT_MS = 10_000;

const channelSchema = z.looseObject({
  counts: z
    .looseObject({ bots: z.number().optional(), total: z.number().optional() })
    .optional(),
  created: z.number().optional(),
  creator: z.string().optional(),
  description: z.string().optional(),
  error: z.string().optional(),
  id: z.string(),
  is_archived: z.boolean().optional(),
  managers: z.array(z.string()).optional(),
  name: z.string().optional(),
  topic: z.string().optional(),
});

// `/cman` is the visibility signal: managers for a public channel, an explicit
// "private" for a private one.
const managersSchema = z.looseObject({
  data: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const searchSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        created: z.number().optional(),
        creator: z.string().optional(),
        id: z.string(),
        name: z.string(),
      })
    )
    .optional(),
});

export interface FlaronChannel {
  createdAt?: string;
  creator?: string;
  description?: string;
  id: string;
  isArchived?: boolean;
  managers?: string[];
  memberCount?: number;
  name?: string;
  source: 'flaron';
  topic?: string;
  visibility: 'public' | 'private' | 'nonexistent' | 'unknown';
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${FLARON_URL}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response.json();
}

function visibilityOf(error: string | undefined, hasData: boolean) {
  if (hasData) {
    return 'public';
  }
  if (error === 'private') {
    return 'private';
  }
  if (error === 'nonexistent') {
    return 'nonexistent';
  }
  return 'unknown';
}

/** A channel by id or name; undefined when Flaron can't be reached. */
export async function lookupFlaronChannel({
  id,
  name,
}: {
  id?: string;
  name?: string;
}): Promise<FlaronChannel | undefined> {
  const path = id
    ? `/cid/${encodeURIComponent(id)}`
    : `/cname/${encodeURIComponent((name ?? '').replace(/^#/, ''))}`;
  const channel = channelSchema.safeParse(
    await getJson(path).catch(() => null)
  );
  if (!channel.success) {
    return;
  }
  const info = channel.data;
  const managers = managersSchema.safeParse(
    await getJson(`/cman/${encodeURIComponent(info.id)}`).catch(() => null)
  );
  const visibility = managers.success
    ? visibilityOf(managers.data.error, Boolean(managers.data.data))
    : 'unknown';
  return {
    ...(info.created
      ? { createdAt: new Date(info.created * 1000).toISOString() }
      : {}),
    creator: info.creator,
    description: info.description,
    id: info.id,
    isArchived: info.is_archived,
    managers: info.managers,
    memberCount: info.counts?.total,
    name: info.name,
    source: 'flaron',
    topic: info.topic,
    visibility: info.error === 'nonexistent' ? 'nonexistent' : visibility,
  };
}

/** Channels whose name matches `query`, private ones included (name only). */
export async function searchFlaronChannels(
  query: string
): Promise<{ id: string; name: string }[]> {
  const result = searchSchema.safeParse(
    await getJson(`/channels/search?q=${encodeURIComponent(query)}`)
  );
  return (result.success ? (result.data.data ?? []) : []).map(
    ({ id, name }) => ({ id, name })
  );
}
