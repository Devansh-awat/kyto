import { tool } from 'ai';
import { z } from 'zod';
import { lookupFlaronUser } from '@/lib/flaron';
import { resolveUserProfile } from '@/lib/slack/names';

// Hack Club Auth's public, keyless verification check: asked only when Flaron
// (which carries the same status) has none.
const HCA_CHECK_URL = 'https://auth.hackclub.com/api/external/check';
const HCA_TIMEOUT_MS = 5000;
const hcaSchema = z.looseObject({ result: z.string() });

export function getUserTool() {
  return tool({
    description:
      "Look up a Slack user's profile by their user id (like U0123ABCD): display name, real name, pronouns, title, status, and custom profile fields (Website, GitHub, etc.), plus what the Flaron directory knows: Hack Club Auth identity verification (`verified_eligible`, `verified_but_over_18`, `pending`, `needs_submission`, `rejected`, `not_found`), timezone, admin/guest/deactivated flags, NDA status and Flaron's fraud tier (its own label, reported verbatim; don't read more into it). Use their pronouns when referring to them.",
    inputSchema: z.object({
      userId: z.string().min(1),
    }),
    execute: async ({ userId }) => {
      const [profile, flaron] = await Promise.all([
        resolveUserProfile(userId),
        lookupFlaronUser(userId).catch(() => undefined),
      ]);
      const verification =
        flaron?.idvStatus ??
        hcaSchema.safeParse(
          await fetch(
            `${HCA_CHECK_URL}?slack_id=${encodeURIComponent(userId)}`,
            { signal: AbortSignal.timeout(HCA_TIMEOUT_MS) }
          )
            .then((response) => response.json())
            .catch(() => null)
        ).data?.result;
      const directory = {
        ...(flaron ? { flaron: { ...flaron, idvStatus: undefined } } : {}),
        ...(verification ? { hackClubVerification: verification } : {}),
      };
      if (!profile) {
        return {
          found: false,
          ...directory,
          summary: `Could not find a Slack profile for ${userId}.${flaron ? ' Flaron knows them (below).' : ''}`,
          userId,
        };
      }
      const fields = profile.fields ?? [];
      return {
        found: true,
        fields,
        fullName: profile.realName,
        pronouns: profile.pronouns,
        status: profile.status,
        ...directory,
        summary: `${profile.displayName ?? userId}${profile.pronouns ? ` (${profile.pronouns})` : ''}${profile.title ? `, ${profile.title}` : ''}.${verification ? ` Hack Club verification: ${verification}.` : ''}`,
        title: profile.title,
        userId,
        userName: profile.displayName,
      };
    },
  });
}
