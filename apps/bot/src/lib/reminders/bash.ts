import type { Reminder } from '@repo/db/queries';
import {
  LazySandbox,
  mayHaveFetchedRepo,
  runOnce,
  sanitizeGitRepos,
} from '@repo/sandbox';
import { env } from '@/env';
import logger from '@/lib/logger';
import { openSandboxProxies } from '@/lib/sandbox/proxies';
import { threadSandboxStore, withThreadSandbox } from '@/lib/sandbox/store';

const MAX_OUTPUT_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`
    : text;
}

function format({
  exitCode,
  stderr,
  stdout,
}: {
  exitCode: number;
  stderr: string;
  stdout: string;
}): string {
  const parts = [
    truncate(stdout.trim()),
    stderr.trim() ? `stderr:\n${truncate(stderr.trim())}` : '',
  ].filter(Boolean);
  const output = parts.join('\n\n') || '(no output)';
  return exitCode === 0 ? output : `${output}\n\n(exit code ${exitCode})`;
}

/**
 * Run a bash reminder's command and return its exact output.
 *
 * It runs in the PERSISTENT SANDBOX OF THE THREAD the reminder was created in,
 * so the command can use scripts and data kyto wrote while setting the reminder
 * up. The thread's sandbox lock is held for the duration — a live turn in that
 * same thread must not pause the sandbox mid-command.
 *
 * The command can also query Slack read-only via the `slack <method>` helper: a
 * FRESH proxy token is minted for this fire and revoked immediately after, since
 * the token from the turn that created the reminder was revoked when that turn
 * ended. Without this a scheduled script could only ever 401.
 *
 * A reminder created before thread sandboxes existed (no `threadId`) falls back
 * to a throwaway sandbox, which starts empty every fire.
 */
export async function runReminderBash(reminder: Reminder): Promise<string> {
  const command = reminder.command;
  if (!command) {
    throw new Error("Bash reminder is missing a 'command'.");
  }
  if (!reminder.threadId) {
    return format(await runOnce(command, env.E2B_API_KEY));
  }
  const threadId = reminder.threadId;
  return await withThreadSandbox(threadId, async () => {
    // A GitHub write from a reminder is guarded as the person who CREATED it —
    // the job outlives the turn, so there is no other principal to check.
    const proxies = openSandboxProxies({
      isOwner: reminder.userId === env.OWNER_USER_ID,
      threadId,
      userId: reminder.userId,
    });
    const sandbox = new LazySandbox({
      apiKey: env.E2B_API_KEY,
      bootstrapCommand: proxies.bootstrapCommand,
      env: proxies.env,
      logger,
      sessionId: threadId,
      store: threadSandboxStore,
    });
    try {
      const result = await sandbox.run({ command });
      // Same disarm the `bash` tool does. A scheduled command is model-authored
      // and runs unattended on a timer, so a repo it clones would sit armed in
      // the thread's PERSISTENT sandbox until an ordinary git command in a later
      // turn ran its config's command.
      if (mayHaveFetchedRepo(command)) {
        await sanitizeGitRepos({
          dirs: [sandbox.workDir],
          runner: sandbox,
        }).catch(() => undefined);
      }
      return format(result);
    } finally {
      proxies.revoke();
      // Pauses (not kills) the thread's sandbox — same as a turn does.
      await sandbox.destroy().catch(() => undefined);
    }
  });
}
