import type { SandboxContext } from '@repo/ai';
import { claimGithubRepo, getGithubRepos } from '@repo/db/queries';
import { env } from '@/env';
import { canEdit } from '@/lib/ai/tools/editors';
import logger from '@/lib/logger';
import { parseGithubCommand } from './command';

/**
 * kyto has ONE GitHub identity, so GitHub's own permissions can't tell two Slack
 * users apart: anything kyto can write, everybody who can talk to kyto can write
 * through it. This is the missing half — a repo kyto creates for someone (or
 * first writes to on their behalf, inside kyto's own namespace) is claimed for
 * them, and after that only they, their named editors, and the bot owner can get
 * kyto to change it. Reads stay open to everyone.
 *
 * Enforcement is at execute time against the REQUESTING user, never against
 * whoever the model says it is acting for — same rule as reminders and sites.
 */

/** kyto's own GitHub account; PRs and commits by it are kyto's own work. */
export const GITHUB_LOGIN = env.GH_LOGIN;

export type GithubGuard =
  | { allowed: true; claim: () => Promise<void> }
  | { allowed: false; reason: string };

const ALLOW_NOOP: GithubGuard = {
  allowed: true,
  claim: () => Promise.resolve(),
};

/** Whether a repo lives under kyto's own GitHub account. */
function inKytoNamespace(repo: string): boolean {
  return repo.split('/').at(0) === GITHUB_LOGIN.toLowerCase();
}

/**
 * Resolve the push target of a checkout when the command didn't name one
 * (`git push` with no URL). Best effort: an unresolvable remote leaves the
 * command ungated rather than blocking legitimate work.
 */
async function remoteRepos({
  context,
  workingDirectory,
}: {
  context: SandboxContext;
  workingDirectory?: string;
}): Promise<string[]> {
  try {
    const result = await context.session.run({
      command:
        'git remote 2>/dev/null | while read -r name; do git remote get-url "$name" 2>/dev/null; done',
      workingDirectory: workingDirectory ?? context.sessionWorkDir,
    });
    const found = new Set<string>();
    for (const line of result.stdout.split('\n')) {
      const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
        line.trim()
      );
      if (match) {
        found.add(`${match[1]}/${match[2]}`.toLowerCase());
      }
    }
    return [...found];
  } catch {
    return [];
  }
}

/**
 * Check a shell command against repo ownership BEFORE running it. Returns a
 * refusal to hand back to the model, or an allowance carrying a `claim()` the
 * caller runs once the command has actually succeeded (so a failed command never
 * claims a repo).
 */
export async function guardGithubCommand({
  command,
  context,
  isOwner,
  userId,
  workingDirectory,
}: {
  command: string;
  /** Used to resolve a bare `git push` to its remote. Omit to skip that. */
  context?: SandboxContext;
  isOwner: boolean;
  userId: string;
  workingDirectory?: string;
}): Promise<GithubGuard> {
  const parsed = parseGithubCommand(command);
  if (!parsed.mutating) {
    return ALLOW_NOOP;
  }
  const targets = new Set(parsed.repos);
  if (parsed.needsRemote && context) {
    for (const repo of await remoteRepos({ context, workingDirectory })) {
      targets.add(repo);
    }
  }
  if (targets.size === 0) {
    return ALLOW_NOOP;
  }

  const claims = await getGithubRepos([...targets]).catch((error: unknown) => {
    logger.warn({ err: error }, '[github] failed to read repo claims');
    return [];
  });
  for (const claim of claims) {
    if (
      canEdit({
        editorUserIds: claim.editorUserIds ?? null,
        isOwner,
        ownerUserId: claim.ownerUserId,
        userId,
      })
    ) {
      continue;
    }
    return {
      allowed: false,
      reason: `Refused: the GitHub repo "${claim.repo}" belongs to <@${claim.ownerUserId}>, who set it up through you. Only they, anyone they named as an editor, and the bot owner can have you change it — so don't close/merge/edit/push there for this person, and don't look for another route to do it. Reading it is fine. Tell them whose repo it is and that <@${claim.ownerUserId}> can add them as an editor.`,
    };
  }

  // Nothing blocked. Claim on success: repos this command creates (whoever they
  // belong to on GitHub), plus repos in kyto's own namespace that it writes to —
  // those are the ones where kyto's single identity is the only access control.
  const unclaimed = [...targets].filter(
    (repo) => !claims.some((claim) => claim.repo === repo)
  );
  const toClaim = [
    ...new Set([
      ...parsed.creates,
      ...unclaimed.filter((repo) => inKytoNamespace(repo)),
    ]),
  ];
  if (toClaim.length === 0) {
    return ALLOW_NOOP;
  }
  return {
    allowed: true,
    claim: async () => {
      for (const repo of toClaim) {
        await claimGithubRepo({ ownerUserId: userId, repo }).catch(
          (error: unknown) => {
            logger.warn({ err: error, repo }, '[github] failed to claim repo');
          }
        );
      }
    },
  };
}
