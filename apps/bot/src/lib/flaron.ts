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

const userSchema = z.looseObject({
  data: z
    .looseObject({
      fraud: z.string().nullish(),
      idv_status: z.string().nullish(),
      nda: z
        .looseObject({
          nda_version: z.string().nullish(),
          status: z.string().nullish(),
        })
        .nullish(),
      user: z
        .looseObject({
          deleted: z.boolean().optional(),
          is_admin: z.boolean().optional(),
          is_owner: z.boolean().optional(),
          is_primary_owner: z.boolean().optional(),
          is_restricted: z.boolean().optional(),
          is_ultra_restricted: z.boolean().optional(),
          name: z.string().optional(),
          tz: z.string().nullish(),
          tz_label: z.string().nullish(),
        })
        .optional(),
    })
    .optional(),
});

export interface FlaronUser {
  deleted?: boolean;
  /** Flaron's fraud tier, verbatim (e.g. "blue"); its meaning is Flaron's. */
  fraud?: string;
  /** Hack Club Auth identity verification, e.g. `verified_eligible`. */
  idvStatus?: string;
  /** Workspace admin or owner. */
  isAdmin?: boolean;
  /** A single- or multi-channel guest. */
  isGuest?: boolean;
  nda?: { status?: string; version?: string };
  timezone?: string;
  userName?: string;
}

/**
 * Flaron's view of a user (owner's ask 2026-10-17: everything it gives, fraud
 * tier included); undefined when Flaron can't be reached or doesn't know them.
 */
export async function lookupFlaronUser(
  id: string
): Promise<FlaronUser | undefined> {
  const parsed = userSchema.safeParse(
    await getJson(`/user/${encodeURIComponent(id)}`).catch(() => null)
  );
  const data = parsed.success ? parsed.data.data : undefined;
  if (!data) {
    return;
  }
  const user = data.user;
  return {
    deleted: user?.deleted,
    fraud: data.fraud ?? undefined,
    idvStatus: data.idv_status ?? undefined,
    isAdmin: user
      ? Boolean(user.is_admin || user.is_owner || user.is_primary_owner)
      : undefined,
    isGuest: user
      ? Boolean(user.is_restricted || user.is_ultra_restricted)
      : undefined,
    nda: data.nda
      ? {
          status: data.nda.status ?? undefined,
          version: data.nda.nda_version ?? undefined,
        }
      : undefined,
    timezone: user?.tz_label ?? user?.tz ?? undefined,
    userName: user?.name,
  };
}
