import { slack } from '@/lib/chat';
import type { ResolvedIdentity } from '@/lib/identity';
import logger from '@/lib/logger';

// A per-post identity override for postMessage: either a FULLY custom name +
// icon, or "look like this person/bot" (their display name + avatar copied onto
// the post). Slack still tags a customized bot post with an APP badge, so this
// dresses a message up — it is not a true takeover of the person's account.
//
// OWNER-ONLY (enforced by the caller): wearing another member's name and avatar
// is an impersonation vector, so only the bot owner may use it, and cross-channel
// posts still pass through the confirm-click gate before they send.

const MENTION = /^<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>$/;
const RAW_ID = /^[UWB][A-Z0-9]+$/;

function idOf(asUser: string): string | undefined {
  const trimmed = asUser.trim();
  const mention = trimmed.match(MENTION);
  if (mention) {
    return mention[1];
  }
  return RAW_ID.test(trimmed) ? trimmed : undefined;
}

// The avatar + display name of a real user or bot, so a post can be dressed to
// look like it came from them. Best-effort: a lookup failure just drops the
// avatar/name and the override falls back to whatever asName/asIcon supplied.
async function lookupProfile(
  id: string
): Promise<{ username?: string; iconUrl?: string }> {
  try {
    if (id.startsWith('B')) {
      const res = (await slack.webClient.apiCall('bots.info', { bot: id })) as {
        bot?: { name?: string; icons?: Record<string, string> };
      };
      const bot = res.bot;
      return {
        iconUrl: bot?.icons?.image_72 ?? bot?.icons?.image_48,
        username: bot?.name,
      };
    }
    const res = (await slack.webClient.apiCall('users.info', {
      user: id,
    })) as {
      user?: {
        name?: string;
        real_name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
          image_192?: string;
          image_512?: string;
        };
      };
    };
    const user = res.user;
    const profile = user?.profile;
    return {
      iconUrl: profile?.image_512 ?? profile?.image_192,
      username:
        profile?.display_name?.trim() ||
        profile?.real_name?.trim() ||
        user?.real_name ||
        user?.name,
    };
  } catch (error) {
    logger.warn({ err: error, id }, '[post-identity] profile lookup failed');
    return {};
  }
}

function iconFields(icon: string): { iconEmoji?: string; iconUrl?: string } {
  const trimmed = icon.trim();
  if (/^https?:\/\//.test(trimmed)) {
    return { iconUrl: trimmed };
  }
  if (/^:[\w+-]+:$/.test(trimmed)) {
    return { iconEmoji: trimmed };
  }
  return {};
}

/**
 * Build the identity a post should wear from the model-supplied overrides.
 * Returns undefined when nothing was asked for, so the caller keeps kyto's
 * configured identity. `asUser` seeds name + avatar from a real person/bot;
 * `asName`/`asIcon` then override whichever of them is given (and let you set a
 * fully custom identity with no `asUser` at all).
 */
export async function resolvePostIdentity({
  asUser,
  asName,
  asIcon,
}: {
  asUser?: string;
  asName?: string;
  asIcon?: string;
}): Promise<ResolvedIdentity | undefined> {
  if (!(asUser || asName || asIcon)) {
    return;
  }
  let identity: ResolvedIdentity = {};
  if (asUser) {
    const id = idOf(asUser);
    if (id) {
      identity = await lookupProfile(id);
    } else {
      // A plain name, not an id/mention — use it as the display name directly
      // (no avatar to copy).
      identity = { username: asUser.trim() };
    }
  }
  if (asName?.trim()) {
    identity.username = asName.trim();
  }
  if (asIcon?.trim()) {
    const fields = iconFields(asIcon);
    // A new icon replaces any avatar copied from asUser.
    identity.iconEmoji = fields.iconEmoji;
    identity.iconUrl = fields.iconUrl;
  }
  return identity.username || identity.iconUrl || identity.iconEmoji
    ? identity
    : undefined;
}
