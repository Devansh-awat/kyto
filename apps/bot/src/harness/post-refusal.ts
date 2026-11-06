import { z } from 'zod';

const slackErrorSchema = z.looseObject({
  data: z.looseObject({ error: z.string().optional() }).optional(),
});

/**
 * Slack errors that mean "the app may not post in this channel", not "the
 * message is bad": a channel that only lets some people post answers
 * `restricted_action` (#172), one the app isn't in `not_in_channel`, and a
 * PRIVATE one the app isn't in `channel_not_found` (#13). Each used to drop the
 * reply silently while the turn logged complete.
 */
const CANNOT_POST_HERE = new Set([
  'restricted_action',
  'not_in_channel',
  'channel_not_found',
]);

export function cannotPostCode(error: unknown): string | undefined {
  const code = slackErrorSchema.safeParse(error).data?.data?.error;
  return code && CANNOT_POST_HERE.has(code) ? code : undefined;
}

/**
 * The line under a reply that had to go out another way, so nobody wonders
 * why it came from kyto's account or landed in a DM. Kyto's own voice: lower
 * case, italic, no em dashes (owner's call 2026-11-06).
 */
export function cannotPostNote({
  channel,
  code,
  via,
}: {
  /** Named in the DM, which is read away from the channel. */
  channel?: string;
  code: string;
  via: 'account' | 'dm';
}): string {
  const where = via === 'dm' && channel ? `in <#${channel}>` : 'here';
  const which = via === 'dm' ? 'that' : 'this';
  const why =
    code === 'restricted_action'
      ? `${which} channel only lets certain people post, so the app couldn’t reply ${where}`
      : `the app isn’t in ${which} channel, so it couldn’t reply ${where}`;
  return via === 'account'
    ? `_${why}. sending it from my account instead_`
    : `_${why}, and my account couldn’t post there either. here’s what i wrote:_`;
}
