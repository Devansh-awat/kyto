import { getIdentityProfiles, type IdentityProfile } from '@repo/db/queries';
import logger from '@/lib/logger';

// kyto's per-message-type presentation. The base name is ALWAYS "kyto"; a
// profile only adds an optional suffix and icon. Applied where kyto posts a
// given kind of message (reminder DMs, the subagent's block, cross-channel
// posts). See the identity_profiles table + App Home config.

export type IdentityType = 'normal' | 'subagent' | 'reminder';

export const IDENTITY_TYPES: IdentityType[] = [
  'normal',
  'subagent',
  'reminder',
];

const BASE_NAME = 'kyto';
const CACHE_TTL_MS = 30_000;

export interface ResolvedIdentity {
  iconEmoji?: string;
  iconUrl?: string;
  username?: string;
}

let cache: { at: number; profiles: IdentityProfile[] } | null = null;

/** Drop the cache so a fresh App Home change is applied immediately. */
export function resetIdentityCache(): void {
  cache = null;
}

async function loadProfiles(): Promise<IdentityProfile[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.profiles;
  }
  const profiles = await getIdentityProfiles().catch((error: unknown) => {
    logger.warn({ err: error }, '[identity] failed to load profiles');
    return [] as IdentityProfile[];
  });
  cache = { at: Date.now(), profiles };
  return profiles;
}

function iconFields(icon: string | null): {
  iconEmoji?: string;
  iconUrl?: string;
} {
  const trimmed = icon?.trim();
  if (!trimmed) {
    return {};
  }
  if (/^https?:\/\//.test(trimmed)) {
    return { iconUrl: trimmed };
  }
  // A Slack emoji code like `:robot_face:`. Unicode emoji can't be an
  // icon_emoji, so only pass through the `:name:` form.
  if (/^:[\w+-]+:$/.test(trimmed)) {
    return { iconEmoji: trimmed };
  }
  return {};
}

/** The name + icon overrides for a message type, or {} when unset. */
export async function resolveIdentity(
  type: IdentityType
): Promise<ResolvedIdentity> {
  const profiles = await loadProfiles();
  const profile = profiles.find((p) => p.messageType === type);
  if (!profile) {
    return {};
  }
  const suffix = profile.nameSuffix?.trim();
  return {
    ...iconFields(profile.icon),
    ...(suffix ? { username: `${BASE_NAME} ${suffix}` } : {}),
  };
}
