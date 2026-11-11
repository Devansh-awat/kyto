import type { SandboxContext } from '@repo/ai';
import { mayHaveFetchedRepo, sanitizeGitRepos } from '@repo/sandbox';
import logger from '@/lib/logger';

/**
 * Disarm any git repo a tool call just brought into the sandbox — hooks and the
 * config keys that name a command to run. The model is never asked to do this;
 * the tools call it themselves after any command that could have fetched or
 * extracted a repository (see `mayHaveFetchedRepo`).
 *
 * Best effort and non-fatal: the tool's own result is returned to the model
 * whatever happens here. Returns a notice for the tool result when something
 * hostile was removed (an executable hook or config key, not git's inert
 * `.sample` templates), so the model can warn the user; undefined otherwise.
 */
export async function disarmFetchedRepos({
  abortSignal,
  command,
  context,
  workingDirectory,
}: {
  abortSignal?: AbortSignal;
  /** The command that just ran; skipped when it can't have fetched a repo. */
  command?: string;
  context: SandboxContext;
  /** Extra directory to scan alongside the workspace. */
  workingDirectory?: string;
}): Promise<string | undefined> {
  if (command !== undefined && !mayHaveFetchedRepo(command)) {
    return;
  }
  // /tmp too: an archive extracted there is as live as one in the workspace.
  const dirs = [context.sessionWorkDir, '/tmp'];
  const insideWorkspace =
    workingDirectory === context.sessionWorkDir ||
    workingDirectory?.startsWith(`${context.sessionWorkDir}/`);
  if (workingDirectory && !insideWorkspace) {
    dirs.push(workingDirectory);
  }
  const result = await sanitizeGitRepos({
    abortSignal,
    dirs,
    runner: context.session,
  });
  if (result && (result.hooks > 0 || result.keys.length > 0)) {
    logger.info(
      { hooks: result.hooks, keys: result.keys, repos: result.repos },
      '[sandbox] stripped git hooks / executable config from a fetched repo'
    );
  }
  if (result && (result.hookNames.length > 0 || result.keys.length > 0)) {
    const removed = [
      result.hookNames.length > 0 && `hooks: ${result.hookNames.join(', ')}`,
      result.keys.length > 0 && `config keys: ${result.keys.join(', ')}`,
    ].filter(Boolean);
    return `SECURITY: this repo carried auto-running git code, which the sandbox removed (${removed.join('; ')}). Tell the user in your reply: what was removed, that the archive/repo is hostile, that opening it outside the sandbox would run that code, and that other archives from the same sender deserve suspicion.`;
  }
  return;
}
