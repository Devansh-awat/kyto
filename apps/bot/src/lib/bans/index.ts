// Banning: the owner telling kyto to stop answering someone.
//
// It is a gate on being ANSWERED, not a filter on being read. A banned person's
// messages still sit in the threads kyto reads, because a conversation makes no
// sense with holes in it — kyto simply will not act on them or reply to them.
//
// OWNER ONLY, checked here rather than at the call site, so both entry points
// (`/kyto ban` and `@kyto!ban`) are covered by one check that cannot be
// forgotten. Everything else about this is deliberately boring: an injection
// that reaches the model can't get here, because the model has no ban tool.

import {
  type BannedUser,
  createBan,
  listBans,
  removeBan,
} from '@repo/db/queries';
import { env } from '@/env';
import logger from '@/lib/logger';
import { formatBanDuration, parseBanDuration } from './duration';

// Slack ids, either as a real `<@U…>` mention or pasted bare — same shape the
// other commands accept.
const MENTIONED_USER =
  /<@([UW][A-Z0-9]{6,})(?:\|[^>]+)?>|\b([UW][A-Z0-9]{6,})\b/;

// The ban list is read on EVERY message, and it is almost always empty. One
// query per window instead of one per message; a ban applies within this.
const CACHE_TTL_MS = 20_000;

let cache: { at: number; bans: Map<string, BannedUser> } | undefined;

async function bans(): Promise<Map<string, BannedUser>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.bans;
  }
  const rows = await listBans().catch((error: unknown) => {
    logger.warn({ err: error }, '[bans] could not read the ban list');
    return [] as BannedUser[];
  });
  const map = new Map(rows.map((row) => [row.userId, row]));
  cache = { at: Date.now(), bans: map };
  return map;
}

/** The live ban for this user, or null. Null on any DB trouble: a database
 * hiccup must not silently ban the workspace. */
export async function activeBan(userId: string): Promise<BannedUser | null> {
  const row = (await bans()).get(userId);
  if (!row) {
    return null;
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return row;
}

/** What to tell someone who just got ignored. */
export function banNotice(ban: BannedUser): string {
  const until = ban.expiresAt
    ? `until ${ban.expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`
    : 'indefinitely';
  return `you're banned from using kyto ${until} — reason: ${ban.reason}. talk to <@${env.OWNER_USER_ID ?? 'the bot owner'}> if that's wrong.`;
}

/**
 * Run a ban subcommand and return what to say back. One implementation for
 * both `/kyto ban …` and `@kyto!ban …`.
 *
 * `action` is 'ban' | 'unban' | 'bans'; `args` is everything after it.
 */
export async function runBanCommand({
  action,
  args,
  userId,
}: {
  action: 'ban' | 'bans' | 'unban';
  args: string;
  userId: string;
}): Promise<string> {
  if (!env.OWNER_USER_ID || userId !== env.OWNER_USER_ID) {
    return 'only the bot owner can do that.';
  }
  if (action === 'bans') {
    return await describeBans();
  }
  const match = args.match(MENTIONED_USER);
  const target = match?.[1] ?? match?.[2];
  if (!target) {
    return action === 'ban'
      ? 'usage: `ban @someone 1d reason` — time can be 30m, 2h, 1d, 1w or `forever`.'
      : 'usage: `unban @someone`.';
  }
  if (action === 'unban') {
    cache = undefined;
    const lifted = await removeBan(target);
    logger.info({ target, userId }, '[bans] lifted');
    return lifted ? `<@${target}> is unbanned.` : `<@${target}> wasn't banned.`;
  }
  return await applyBan({ args, match: match?.[0] ?? '', target, userId });
}

async function applyBan({
  args,
  match,
  target,
  userId,
}: {
  args: string;
  match: string;
  target: string;
  userId: string;
}): Promise<string> {
  if (target === userId) {
    return "you can't ban yourself.";
  }
  // Everything after the mention: `<duration> <reason…>`.
  const rest = args.slice(args.indexOf(match) + match.length).trim();
  const [first = '', ...restWords] = rest.split(/\s+/);
  const duration = parseBanDuration(first);
  if (!duration) {
    return `\`${first || '(nothing)'}\` isn't a length of time. Try \`ban <@${target}> 1d being a nuisance\` — 30m, 2h, 1d, 1w or \`forever\`.`;
  }
  const reason = restWords.join(' ').trim();
  // Required on purpose: a ban nobody can explain later is one nobody can lift
  // fairly, and the person being ignored is told the reason.
  if (!reason) {
    return `that ban needs a reason. \`ban <@${target}> ${first} <why>\`.`;
  }
  const expiresAt =
    duration.ms === null ? null : new Date(Date.now() + duration.ms);
  cache = undefined;
  await createBan({ bannedBy: userId, expiresAt, reason, userId: target });
  logger.info({ expiresAt, reason, target, userId }, '[bans] user banned');
  return `<@${target}> is banned ${duration.ms === null ? 'indefinitely' : `for ${formatBanDuration(duration.ms)}`} — ${reason}. kyto will ignore them until then; \`unban <@${target}>\` lifts it.`;
}

async function describeBans(): Promise<string> {
  const rows = await listBans();
  if (rows.length === 0) {
    return 'nobody is banned.';
  }
  const lines = rows.map((row) => {
    const until = row.expiresAt
      ? `until ${row.expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : 'indefinitely';
    return `• <@${row.userId}> — ${until} — ${row.reason}`;
  });
  return `banned right now:\n${lines.join('\n')}`;
}
