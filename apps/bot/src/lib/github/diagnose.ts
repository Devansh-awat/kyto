/**
 * Turn git/gh authentication failures into something the model can act on.
 *
 * kyto's GitHub credential lives on the host, behind the GitHub proxy
 * (lib/github-proxy), so from inside the sandbox there is no token to inspect
 * and no `gh auth status` that means anything. When the token is revoked or
 * expired the proxy leaves it OFF, so public reads keep working anonymously and
 * what fails is anything that needs auth — with messages ("could not read
 * Username", "requires authentication") that read like the repo is private.
 *
 * That has already cost a turn: kyto read the message as evidence the repo was
 * private, went looking for other explanations, and reported an environment
 * fault. Naming the real cause is the difference between a stuck turn and a
 * useful one.
 */

// Deliberately excludes a bare `gh: Not Found` / HTTP 404. A missing repo and a
// rejected token both 404, and asserting "your credentials are dead" over an
// ordinary typo'd repo name would send a turn down the wrong path just as
// surely as saying nothing did. "Repository not found" from git itself stays,
// because that IS GitHub masking an auth failure on a fetch or push.
const AUTH_FAILURE =
  /could not read Username|Authentication failed|Invalid username or (?:password|token)|Bad credentials|HTTP 401|401 Unauthorized|remote: (?:Invalid|Repository not found)|requires authentication/i;

const TOUCHES_GITHUB = /github\.com|gh:\s|\bgh\b/i;

const HINT =
  "GitHub refused this for lack of valid credentials. kyto's GitHub token lives on the host, behind kyto's GitHub proxy, so nothing inside the sandbox can read, refresh, or replace it and `gh auth` commands won't help. If this was a WRITE (push, PR, issue, comment), the token is most likely dead and needs the bot owner to rotate GH_TOKEN — tell whoever asked rather than retrying. Public reads still work without it (the proxy leaves a dead token off), so a failing READ more likely means the repo really is private or the name is wrong.";

// A repo can refuse a pull request from kyto's account outright — GitHub answers
// `GraphQL: <login> does not have the correct permissions to execute
// \`CreatePullRequest\``. It is NOT an auth failure and NOT transient, but it
// reads like one: an observed turn re-created the fork, waited for the fork
// network to "propagate", checked `parent`, and retried five times before giving
// up, because nothing told it the answer would never change.
const PR_PERMISSION_FAILURE =
  /does not have the correct permissions to execute .?CreatePullRequest|not authorized to create a pull request/i;

const PR_PERMISSION_HINT =
  "GitHub refused the pull request itself, not your credentials: that repository does not let kyto's account (kyto-agent) open a PR — some repos restrict pull requests to collaborators or to members of the org. This will NOT change on a retry, and it is not a fork problem: re-forking, waiting for the fork network, pushing again, or calling the REST API instead all hit the same wall. Stop retrying. Tell whoever asked that the branch is pushed and the repo won't accept a PR from kyto, and offer them the compare link (https://github.com/OWNER/REPO/compare/BASE...kyto-agent:BRANCH) so they can open it from their own account.";

/**
 * A hint to append to a failed command's result, or undefined when the failure
 * had nothing to do with GitHub auth.
 */
export function githubAuthHint({
  command,
  exitCode,
  stderr,
}: {
  command: string;
  exitCode: number;
  stderr: string;
}): string | undefined {
  if (exitCode === 0) {
    return;
  }
  if (PR_PERMISSION_FAILURE.test(stderr)) {
    return PR_PERMISSION_HINT;
  }
  if (!AUTH_FAILURE.test(stderr)) {
    return;
  }
  if (!(TOUCHES_GITHUB.test(command) || TOUCHES_GITHUB.test(stderr))) {
    return;
  }
  return HINT;
}
