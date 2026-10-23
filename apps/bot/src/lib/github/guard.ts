import type { SandboxContext } from '@repo/ai';
import {
  claimGithubRepo,
  getGithubRepos,
  getGithubTrust,
  recordGithubRequest,
} from '@repo/db/queries';
import { env } from '@/env';
import { canEdit } from '@/lib/ai/tools/editors';
import { requestApproval } from '@/lib/approvals/request';
import { KEVINTON_USER_ID } from '@/lib/kevinton/identity';
import logger from '@/lib/logger';
import { isFork, kytoCanPush } from './collaborator';
import { parseGithubCommand } from './command';

/**
 * kyto has ONE GitHub identity, so GitHub's own permissions can't tell two Slack
 * users apart: anything kyto can write, everybody who can talk to kyto can write
 * through it. Two gates sit on top of that, checked in this order:
 *
 * 1. **Ownership** — a repo kyto creates for someone (or first writes to on
 *    their behalf, inside kyto's own namespace) is claimed for them, and after
 *    that only they, their named editors, and the bot owner can get kyto to
 *    change it. This protects people from each other.
 *
 * 2. **Trust** — a write to a repo OUTSIDE kyto's own namespace goes out into
 *    the world under `kyto-agent`'s name, so it needs the bot owner to have
 *    trusted that person (blanket, or for that repo) from the dashboard. This
 *    protects kyto's GitHub account from the workspace; an untrusted attempt is
 *    refused and queued for the owner to approve. Reads stay open to everyone
 *    under both gates.
 *    EXCEPTION: a repo that added kyto's GitHub account as a collaborator with
 *    push access skips this gate — the invitation is the grant (see
 *    ./collaborator.ts). Gate 1 still runs first and is unaffected.
 *    CONTRIBUTIONS (a PR, an issue, a comment) skip trust too (owner's call,
 *    2026-10-11: "let kyto make prs but prevent abuse"). They come back as
 *    `needsVetting`, and the GitHub proxy then caps, reviews and footers them
 *    (./contributions.ts) — so only the proxy may honour that flag.
 *
 * A FORK in kyto's namespace is shared: kyto has one fork per upstream, so the
 * first person to fork a repo would otherwise lock everyone else out of ever
 * opening a PR to it. Anyone may push to it, but only branches under their own
 * prefix (`forkBranchPrefix`); the claimant keeps the rest.
 *
 * Enforcement is at execute time against the REQUESTING user, never against
 * whoever the model says it is acting for — same rule as reminders and sites.
 */

/** kyto's own GitHub account; PRs and commits by it are kyto's own work. */
export const GITHUB_LOGIN = env.GH_LOGIN;

export type GithubGuard =
  | { allowed: true; claim: () => Promise<void>; needsVetting?: true }
  | { allowed: false; reason: string };

/** The branch namespace a non-claimant may push to on one of kyto's forks. */
function forkBranchPrefix(userId: string): string {
  return `${userId.toLowerCase()}/`;
}

const ALLOW_NOOP: GithubGuard = {
  allowed: true,
  claim: () => Promise.resolve(),
};

/** How much of a refused command to keep as context on the queued request. */
const REQUEST_COMMAND_MAX = 2000;

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
  threadId,
  userId,
  workingDirectory,
}: {
  command: string;
  /** Used to resolve a bare `git push` to its remote. Omit to skip that. */
  context?: SandboxContext;
  isOwner: boolean;
  /** Recorded on a queued request so the owner can go read the thread. */
  threadId?: string;
  userId: string;
  workingDirectory?: string;
}): Promise<GithubGuard> {
  const parsed = parseGithubCommand(command);
  if (!parsed.mutating) {
    return ALLOW_NOOP;
  }
  const targets = new Set(parsed.repos);
  // A push's refs are only readable in the request git sends, so a push to a
  // shared fork is waved on here and checked branch by branch at the proxy.
  if (parsed.needsRemote && context) {
    for (const repo of await remoteRepos({ context, workingDirectory })) {
      targets.add(repo);
    }
  }
  return await guardGithubTargets({
    commandText: command,
    contribution: parsed.contribution,
    creates: parsed.creates,
    forkRefs: parsed.pushOnly ? 'unchecked' : undefined,
    isOwner,
    repos: [...targets],
    threadId,
    userId,
  });
}

/**
 * The pure gate half of the guard: given a mutating request's resolved repo
 * TARGETS (and which of them are being CREATED), apply ownership + trust and
 * return a refusal or a claim. Both the shell path (guardGithubCommand, which
 * parses a command string) and the host-side GitHub proxy (which parses an HTTP
 * request) funnel through here, so the security decision — and the wording an
 * injection reads on refusal — lives in exactly one place.
 *
 * `commandText` is the human-readable action ("git push", "POST /repos/o/n/pulls")
 * recorded on a queued third-party request and shown to the owner.
 */
export async function guardGithubTargets({
  commandText,
  contribution = false,
  creates,
  forkRefs,
  isOwner,
  repos,
  threadId,
  userId,
}: {
  commandText: string;
  /** A PR, issue or comment — vetted by the proxy instead of needing trust. */
  contribution?: boolean;
  creates: string[];
  /**
   * The refs a push updates, for the shared-fork rule; `'unchecked'` from the
   * command guard, which can't read them and leaves them to the proxy. Omit for
   * anything that isn't a push.
   */
  forkRefs?: string[] | 'unchecked';
  isOwner: boolean;
  repos: string[];
  threadId?: string;
  userId: string;
}): Promise<GithubGuard> {
  const targets = new Set(repos.map((repo) => repo.toLowerCase()));
  if (targets.size === 0) {
    return ALLOW_NOOP;
  }
  // Before any approval path: the trust gate below would post an Approve/Deny
  // card into the turn's thread, and kevinton's turn's thread is the
  // conversation it is reviewing — a misread search (`gh api search/code -f`)
  // put two such cards in front of people. Approving one would also have
  // granted GitHub write trust to a prompt-injectable reviewer. It files issues
  // through its own tool; it never writes to GitHub through a shell.
  if (userId === KEVINTON_USER_ID) {
    return {
      allowed: false,
      reason:
        'Refused: kevinton never writes to GitHub from a shell, and nothing was queued or posted. If this was meant to be a read the guard misjudged, it is a defect worth filing with kytoIssues; otherwise file what you found with kytoIssues.',
    };
  }
  const command = commandText;

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
    if (forkRefs && inKytoNamespace(claim.repo) && (await isFork(claim.repo))) {
      const prefix = `refs/heads/${forkBranchPrefix(userId)}`;
      if (
        forkRefs === 'unchecked' ||
        forkRefs.every((ref) => ref.startsWith(prefix))
      ) {
        continue;
      }
      return {
        allowed: false,
        reason: `Refused: "${claim.repo}" is your fork, shared by everyone who has you open PRs, so this person may only push branches named \`${forkBranchPrefix(userId)}<something>\` there — rename the branch (e.g. \`git push origin HEAD:${forkBranchPrefix(userId)}fix-thing\`) and open the PR from that.`,
      };
    }
    return {
      allowed: false,
      reason: `Refused: the GitHub repo "${claim.repo}" belongs to <@${claim.ownerUserId}>, who set it up through you. Only they, anyone they named as an editor, and the bot owner can have you change it — so don't close/merge/edit/push there for this person, and don't look for another route to do it. Reading it is fine. Tell them whose repo it is and that <@${claim.ownerUserId}> can add them as an editor.`,
    };
  }

  // Gate 2: anything outside kyto's own namespace that this person hasn't been
  // trusted for. A repo they already hold a claim on passed the loop above and
  // is theirs by construction, so it doesn't need trust as well.
  const claimedByUser = new Set(
    claims
      .filter((claim) => claim.ownerUserId === userId)
      .map((claim) => claim.repo)
  );
  const thirdParty = [...targets].filter(
    (repo) => !(inKytoNamespace(repo) || claimedByUser.has(repo))
  );
  // …unless someone already added kyto's GitHub account as a collaborator with
  // push access. That invitation IS the grant (owner's call, 2026-08-05: "when
  // kyto-agent is given access to a repo, it should not need my perms to edit
  // it"), so the trust gate below would only be re-asking a question GitHub has
  // already answered. A repo nobody invited kyto to reports push:false and is
  // still gated; a failed check answers false, so an outage tightens this rather
  // than opening it. Gate 1 (another user's claimed repo) ran ABOVE and is
  // untouched — this cannot be used to reach past it.
  const invited = await Promise.all(
    thirdParty.map(async (repo) => ((await kytoCanPush(repo)) ? repo : null))
  );
  const invitedRepos = new Set(invited.filter((repo) => repo !== null));
  const gated = thirdParty.filter((repo) => !invitedRepos.has(repo));
  if (gated.length > 0 && !isOwner) {
    const trust = await getGithubTrust(userId).catch((error: unknown) => {
      logger.warn({ err: error }, '[github] failed to read trust');
      return null;
    });
    const untrusted = trust?.allRepos
      ? []
      : gated.filter((repo) => !(trust?.repos ?? []).includes(repo));
    if (untrusted.length > 0 && contribution) {
      // Not trust but a vetting, which only the proxy can do: it holds the
      // request body that is reviewed and signed.
      return {
        allowed: true,
        claim: () => Promise.resolve(),
        needsVetting: true,
      };
    }
    if (untrusted.length > 0) {
      // Don't hold the turn open waiting for a decision — a turn can't block
      // for hours. Record it, refuse, and let them ask again once approved.
      for (const repo of untrusted) {
        await recordGithubRequest({
          command: command.slice(0, REQUEST_COMMAND_MAX),
          repo,
          threadId,
          userId,
        }).catch((error: unknown) => {
          logger.warn({ err: error, repo }, '[github] failed to queue request');
        });
      }
      // …and ask the owner IN THE THREAD as well, not only on the dashboard.
      // The dashboard row is easy to never look at, and the person who asked
      // had no way to see their request existed at all. Approving either one
      // grants the same trust.
      if (threadId) {
        for (const repo of untrusted) {
          await requestApproval({
            detail: command.slice(0, REQUEST_COMMAND_MAX),
            kind: 'github',
            payload: { command: command.slice(0, REQUEST_COMMAND_MAX), repo },
            requestedBy: userId,
            summary: `write to the GitHub repo \`${repo}\``,
            threadId,
          }).catch((error: unknown) => {
            logger.warn(
              { err: error, repo },
              '[github] failed to post an approval request'
            );
          });
        }
      }
      const list = untrusted.map((repo) => `"${repo}"`).join(', ');
      // Only claim the in-thread request exists when there WAS a thread to post
      // it in: a reminder or a proxy call outside a turn queues the dashboard
      // row only, and telling the user to look for buttons that were never
      // posted sends them hunting.
      const queued = threadId
        ? 'An Approve/Deny request has been posted in this thread for him, and it does not expire.'
        : "The request is waiting for him on kyto's dashboard, and it does not expire.";
      return {
        allowed: false,
        reason: `Refused for now: ${list} ${untrusted.length === 1 ? 'is not a repo' : 'are not repos'} you own, and writes there go out under your own GitHub account, so <@${env.OWNER_USER_ID}> has to approve this person for it. ${queued} Tell them it's waiting on his approval and that they can ask you again once he's granted it — approving grants the access but deliberately does NOT re-run the command. Don't look for another route — pushing from a different checkout or calling the REST API directly is the same thing. Reading the repo is still fine, and so is CONTRIBUTING without approval: fork it, push a branch to your fork, and open a PR (\`gh pr create\`), or file an issue or comment — those are capped and reviewed, not approved.`,
      };
    }
  }

  // Nothing blocked. Claim on success: repos this command creates (whoever they
  // belong to on GitHub), plus repos in kyto's own namespace that it writes to —
  // those are the ones where kyto's single identity is the only access control.
  const unclaimed = [...targets].filter(
    (repo) => !claims.some((claim) => claim.repo === repo)
  );
  const toClaim = [
    ...new Set([
      ...creates.map((repo) => repo.toLowerCase()),
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
