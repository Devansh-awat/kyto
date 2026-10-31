import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { githubAuthHint } from '@/lib/github/diagnose';
import { guardGithubCommand } from '@/lib/github/guard';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clipOutput, fullOutputPath } from '@/lib/sandbox/output-clip';
import type { BackgroundProcessTools } from './background';
import { resolvePath, shellQuote } from './workspace-files';

// The model's workspace tools (replacing Pi's builtin bash/file tools). Every
// tool runs in the lazy E2B sandbox: the first call materializes it, chat-only
// turns never create one.

// A foreground bash command that runs longer than this is auto-moved to the
// background so it can't freeze the whole turn (a turn blocks until bash
// returns; a slow benchmark or a runaway script would otherwise leave the user
// staring at an empty message until the watchdog kills it). The command keeps
// running detached and the model gets a handle to poll.
const AUTO_BACKGROUND_MS = 60_000;

/**
 * Clip one stream of command output, keeping a full copy in the sandbox so the
 * model can filter what it wasn't shown (see lib/sandbox/output-clip). Saving
 * is best-effort: if the write fails the clip still happens and the notice says
 * the copy is missing, because losing the output entirely is the worse outcome.
 */
async function clipStream(
  text: string,
  context: SandboxContext,
  label: string
): Promise<string> {
  const preview = clipOutput(text);
  if (!preview.truncated) {
    return preview.text;
  }
  const path = fullOutputPath(label);
  try {
    await context.session.writeBinaryFile({
      content: new TextEncoder().encode(text),
      path,
    });
  } catch {
    return preview.text;
  }
  return clipOutput(text, path).text;
}

// A model-set timeout: how long bash may wait before the command is killed.
// Ten minutes, like a coding agent's shell; the watchdog is held for it.
const MAX_TIMEOUT_SECONDS = 600;
const MS_PER_SECOND = 1000;

export function bashTool({
  background,
  extendAttemptDeadline,
  getSandboxContext,
  github,
  onBackgrounded,
}: {
  /** Holds the attempt's stall watchdog open across a long `timeout`. */
  extendAttemptDeadline?: (extraMs: number) => () => void;
  // Shared with the background-process trio, so an auto-backgrounded command is
  // pollable via getProcessOutput. Optional so a caller can opt out of
  // auto-backgrounding (then a long command blocks as before).
  background?: BackgroundProcessTools;
  getSandboxContext: () => SandboxContext;
  /** A command outlived the wait and now needs the `process` tool to follow. */
  onBackgrounded?: () => void;
  /**
   * Who this turn runs for, so a `gh`/`git push` typed into bash goes through
   * the same repo-ownership gate as the `gh` tool — otherwise the gate would be
   * one `bash("gh pr close …")` away from irrelevant. Omit for callers with no
   * requesting user (reminders, subagents inherit their parent's check).
   */
  github?: { isOwner: boolean; threadId?: string; userId: string };
}) {
  return tool({
    description:
      'Run a bash command in your isolated Linux sandbox (network access, common CLIs, bun/node/python preinstalled). The workspace PERSISTS across turns in this thread (files you write and packages you install are still there next time). Without `timeout`, a command still running after ~1 minute is moved to the background and you get a handle to poll with process (action output). Set `timeout` BEFORE a command you know is slow (an install, a build, a test suite) and you wait for it up to that long instead; past it the command is killed. For something you want to keep running (a server, a watcher), use process (action start). Prefer grep and glob over `grep`/`find` here, and readFile over `cat`.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_SECONDS)
        .optional()
        .describe(
          `Seconds to wait before the command is killed (max ${MAX_TIMEOUT_SECONDS}). Omit for the default: moved to the background after ~60s, not killed.`
        ),
      workingDirectory: z
        .string()
        .optional()
        .describe('Working directory (defaults to the workspace).'),
    }),
    execute: async (
      { command, timeout, workingDirectory },
      { abortSignal }
    ) => {
      const context = getSandboxContext();
      const resolvedDir = workingDirectory
        ? resolvePath(context, workingDirectory)
        : undefined;
      const guard = github
        ? await guardGithubCommand({
            command,
            context,
            isOwner: github.isOwner,
            threadId: github.threadId,
            userId: github.userId,
            workingDirectory: resolvedDir,
          })
        : null;
      if (guard?.allowed === false) {
        return { error: guard.reason, exitCode: 1 };
      }
      if (background) {
        const timeoutMs = timeout ? timeout * MS_PER_SECOND : undefined;
        const release = timeoutMs
          ? extendAttemptDeadline?.(timeoutMs)
          : undefined;
        const backgrounded = await runWithAutoBackground({
          abortSignal,
          background,
          command,
          context,
          timeoutMs,
          workingDirectory: resolvedDir,
        }).finally(() => release?.());
        if (backgrounded.running) {
          onBackgrounded?.();
        }
        // Only once it has actually finished — a still-running extraction gets
        // disarmed when getProcessOutput reports it done.
        if (!backgrounded.running) {
          if (backgrounded.exitCode === 0) {
            await guard?.claim();
          }
          await disarmFetchedRepos({
            abortSignal,
            command,
            context,
            workingDirectory: resolvedDir,
          });
        }
        return backgrounded;
      }
      const result = await context.session.run({
        abortSignal,
        // No process registry to kill it through: coreutils does it.
        command: timeout
          ? `timeout -k 5 ${timeout} bash -c ${shellQuote(command)}`
          : command,
        workingDirectory: resolvedDir,
      });
      if (result.exitCode === 0) {
        await guard?.claim();
      }
      await disarmFetchedRepos({
        abortSignal,
        command,
        context,
        workingDirectory: resolvedDir,
      });
      return {
        exitCode: result.exitCode,
        // git/gh reject a revoked brokered token in ways that look like a
        // private repo or a broken environment; name the real cause.
        hint: githubAuthHint({
          command,
          exitCode: result.exitCode,
          stderr: result.stderr,
        }),
        stderr: await clipStream(result.stderr, context, 'stderr'),
        stdout: await clipStream(result.stdout, context, 'stdout'),
      };
    },
  });
}

async function runWithAutoBackground({
  abortSignal,
  background,
  command,
  context,
  timeoutMs,
  workingDirectory,
}: {
  abortSignal?: AbortSignal;
  background: BackgroundProcessTools;
  command: string;
  context: SandboxContext;
  /** The model's own limit: wait this long, then kill instead of moving on. */
  timeoutMs?: number;
  workingDirectory?: string;
}): Promise<
  Record<string, unknown> & { exitCode?: number; running?: boolean }
> {
  const started = await background.startManaged(command, workingDirectory);
  if ('error' in started) {
    return { error: started.error, exitCode: 1 };
  }
  const result = await background
    .waitManaged(started.id, timeoutMs ?? AUTO_BACKGROUND_MS, abortSignal)
    .catch((error: unknown) => {
      // An interrupt cuts the wait, not the command: it keeps running, and
      // the next turn hears about it instead of re-running it.
      if (abortSignal?.aborted) {
        background.orphanManaged(started.id);
      }
      throw error;
    });
  if (!result.finished && timeoutMs) {
    await background.killManaged(started.id);
    return {
      exitCode: 124,
      note: `Killed after the ${Math.round(timeoutMs / MS_PER_SECOND)}s timeout you set; the output below is what it printed until then. If it was making progress, run it again with a longer timeout, or with process (action start) to keep it running.`,
      stderr: await clipStream(result.stderr, context, 'stderr'),
      stdout: await clipStream(result.stdout, context, 'stdout'),
      timedOut: true,
    };
  }
  if (result.finished) {
    return {
      exitCode: result.exitCode,
      stderr: await clipStream(result.stderr, context, 'stderr'),
      stdout: await clipStream(result.stdout, context, 'stdout'),
    };
  }
  background.watchManaged(started.id);
  return {
    backgrounded: true,
    id: started.id,
    note: `This command was still running after 60s, so it was moved to the background (handle "${started.id}") to keep the turn responsive: it is STILL RUNNING. Check it with the \`process\` tool (action \`output\`, id "${started.id}") and stop it with action \`kill\`. Don't just re-run it. If you need its result before replying, keep working on other things and check back, or use the wait tool. If your turn ends first, you'll be woken with its result when it finishes (or told after 30 minutes if it's still going).`,
    running: true,
    stderr: await clipStream(result.stderr, context, 'stderr'),
    stdout: await clipStream(result.stdout, context, 'stdout'),
  };
}
