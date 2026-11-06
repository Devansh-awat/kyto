import { tool } from 'ai';
import { z } from 'zod';
import { lookupFlaronUser } from '@/lib/flaron';
import { resolveUserProfile } from '@/lib/slack/names';

// Hack Club Auth's public, keyless verification check: asked only when Flaron
// (which carries the same status) has none.
const HCA_CHECK_URL = 'https://auth.hackclub.com/api/external/check';
const HCA_TIMEOUT_MS = 5000;
const hcaSchema = z.looseObject({ result: z.string() });

// Hackatime answers its public stats by Slack id, so a username is one GET
// away; kyto once spent 20 searches on look-alike names to find one (#175).
const HACKATIME_URL = 'https://hackatime.hackclub.com/api/v1/users';
const HACKATIME_TOP = 5;
const namedSchema = z.array(
  z.looseObject({ name: z.string(), text: z.string().optional() })
);
const hackatimeSchema = z.looseObject({
  data: z.looseObject({
    human_readable_total: z.string().optional(),
    is_coding_activity_visible: z.boolean().optional(),
    languages: namedSchema.optional(),
    projects: namedSchema.optional(),
    streak: z.number().optional(),
    username: z.string().optional(),
  }),
});
const trustSchema = z.looseObject({ trust_level: z.string() });

async function hackatimeJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(HCA_TIMEOUT_MS),
  });
  // 404: no Hackatime account for that Slack id.
  return response.ok ? response.json() : null;
}

async function lookupHackatime(userId: string) {
  const id = encodeURIComponent(userId);
  const [stats, trust] = await Promise.all([
    hackatimeJson(
      `${HACKATIME_URL}/${id}/stats?features=projects,languages`
    ).catch(() => null),
    hackatimeJson(`${HACKATIME_URL}/${id}/trust_factor`).catch(() => null),
  ]);
  const data = hackatimeSchema.safeParse(stats).data?.data;
  if (!data?.username) {
    return;
  }
  const top = (items: z.infer<typeof namedSchema> | undefined) =>
    items
      ?.filter((item) => item.name !== 'Other')
      .slice(0, HACKATIME_TOP)
      .map((item) => (item.text ? `${item.name} (${item.text})` : item.name));
  return {
    activityVisible: data.is_coding_activity_visible,
    streakDays: data.streak,
    topLanguages: top(data.languages),
    topProjects: top(data.projects),
    totalCoded: data.human_readable_total,
    trustLevel: trustSchema.safeParse(trust).data?.trust_level,
    username: data.username,
  };
}

export function getUserTool() {
  return tool({
    description:
      "Look up a Slack user's profile by their user id (like U0123ABCD): display name, real name, pronouns, title, status, and custom profile fields (Website, GitHub, etc.), plus what the Flaron directory knows: Hack Club Auth identity verification (`verified_eligible`, `verified_but_over_18`, `pending`, `needs_submission`, `rejected`, `not_found`), timezone, admin/guest/deactivated flags, NDA status and Flaron's fraud tier (its own label, reported verbatim; don't read more into it). Plus their Hackatime account, looked up by their Slack id (username, all-time coded time, top languages and projects, streak, Hackatime's trust level, reported verbatim): for “what’s X’s Hackatime” this is the answer, never a search by name. No `hackatime` in the result means that Slack id has no Hackatime account. Use their pronouns when referring to them.",
    inputSchema: z.object({
      userId: z.string().min(1),
    }),
    execute: async ({ userId }) => {
      const [profile, flaron, hackatime] = await Promise.all([
        resolveUserProfile(userId),
        lookupFlaronUser(userId).catch(() => undefined),
        lookupHackatime(userId).catch(() => undefined),
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
        ...(hackatime ? { hackatime } : {}),
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
        summary: `${profile.displayName ?? userId}${profile.pronouns ? ` (${profile.pronouns})` : ''}${profile.title ? `, ${profile.title}` : ''}.${verification ? ` Hack Club verification: ${verification}.` : ''}${hackatime ? ` Hackatime: ${hackatime.username}.` : ''}`,
        title: profile.title,
        userId,
        userName: profile.displayName,
      };
    },
  });
}
