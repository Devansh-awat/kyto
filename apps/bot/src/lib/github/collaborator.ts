import { env } from '@/env';
import logger from '@/lib/logger';

/**
 * Does kyto's GitHub account have PUSH access to this repo?
 *
 * Owner's call, 2026-08-05: "when kyto-agent is given access to a repo, it
 * should not need my perms to edit it". Someone adding `kyto-agent` as a
 * collaborator IS the grant — making the owner then approve every write to a
 * repo he can see kyto was invited to is friction with no security left in it.
 *
 * This deliberately loosens the third-party trust gate (`guardGithubTargets`,
 * gate 2), and the loosening is exactly as wide as GitHub's own permission
 * model: a repo nobody added kyto to reports `push: false` and still needs the
 * owner's approval. A PUBLIC repo kyto merely reads is not affected — reads were
 * never gated.
 *
 * What it does NOT protect against, on purpose (the owner accepted this): any
 * opted-in user can now drive a write to any repo kyto-agent was invited to,
 * without the inviter knowing which human asked. Repos kyto claimed for someone
 * are still checked first, so this can't be used to reach past gate 1.
 */

// Long enough not to be a per-command API call, short enough that revoking
// kyto's access takes effect the same session.
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;

const cache = new Map<string, { at: number; push: boolean }>();

async function askGithub(repo: string, token: string): Promise<boolean> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // 404 for a repo the token can't see, 401/403 for a dead token. None of
    // those are "kyto is a collaborator", so the gate stays closed.
    return false;
  }
  const body = (await response.json()) as {
    permissions?: { push?: boolean };
  };
  return body.permissions?.push === true;
}

/**
 * True when kyto's own GitHub identity can push to `owner/name`. Cached per
 * repo; any failure answers false, so a GitHub outage tightens the gate rather
 * than opening it.
 */
export async function kytoCanPush(repo: string): Promise<boolean> {
  const token = env.GH_TOKEN;
  if (!token) {
    return false;
  }
  const key = repo.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.push;
  }
  const push = await askGithub(key, token).catch((error: unknown) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), repo },
      '[github] collaborator check failed; treating as no access'
    );
    return false;
  });
  cache.set(key, { at: Date.now(), push });
  return push;
}
