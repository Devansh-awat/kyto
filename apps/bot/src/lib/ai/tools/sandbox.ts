import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { githubAuthHint } from '@/lib/github/diagnose';
import { guardGithubCommand } from '@/lib/github/guard';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clamp } from '@/lib/utils/text';
import type { BackgroundProcessTools } from './background';

// The model's workspace tools (replacing Pi's builtin bash/file tools). Every
// tool runs in the lazy E2B sandbox: the first call materializes it, chat-only
// turns never create one.

const OUTPUT_MAX = 12_000;

// A foreground bash command that runs longer than this is auto-moved to the
// background so it can't freeze the whole turn (a turn blocks until bash
// returns; a slow benchmark or a runaway script would otherwise leave the user
// staring at an empty message until the watchdog kills it). The command keeps
// running detached and the model gets a handle to poll.
const AUTO_BACKGROUND_MS = 60_000;

function resolvePath(context: SandboxContext, path: string): string {
  return nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(context.sessionWorkDir, path)
  );
}

function clip(text: string): string {
  return clamp(text, OUTPUT_MAX) ?? text;
}

export function bashTool({
  background,
  getSandboxContext,
  github,
}: {
  // Shared with the background-process trio, so an auto-backgrounded command is
  // pollable via getProcessOutput. Optional so a caller can opt out of
  // auto-backgrounding (then a long command blocks as before).
  background?: BackgroundProcessTools;
  getSandboxContext: () => SandboxContext;
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
      'Run a bash command in your isolated Linux sandbox (network access, common CLIs, bun/node/python preinstalled). The workspace PERSISTS across turns in this thread — files you write and packages you install are still there next time. A command still running after ~1 minute is automatically moved to the background and you get a handle to poll with getProcessOutput — so for anything you expect to be slow, bound it with `timeout` or start it with runBackgroundProcess yourself rather than relying on the auto-move.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      workingDirectory: z
        .string()
        .optional()
        .describe('Working directory (defaults to the workspace).'),
    }),
    execute: async ({ command, workingDirectory }, { abortSignal }) => {
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
        const backgrounded = await runWithAutoBackground({
          abortSignal,
          background,
          command,
          workingDirectory: resolvedDir,
        });
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
        command,
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
        stderr: clip(result.stderr),
        stdout: clip(result.stdout),
      };
    },
  });
}

async function runWithAutoBackground({
  abortSignal,
  background,
  command,
  workingDirectory,
}: {
  abortSignal?: AbortSignal;
  background: BackgroundProcessTools;
  command: string;
  workingDirectory?: string;
}): Promise<
  Record<string, unknown> & { exitCode?: number; running?: boolean }
> {
  const started = await background.startManaged(command, workingDirectory);
  if ('error' in started) {
    return { error: started.error, exitCode: 1 };
  }
  const result = await background.waitManaged(
    started.id,
    AUTO_BACKGROUND_MS,
    abortSignal
  );
  if (result.finished) {
    return {
      exitCode: result.exitCode,
      stderr: clip(result.stderr),
      stdout: clip(result.stdout),
    };
  }
  return {
    backgrounded: true,
    id: started.id,
    note: `This command was still running after 60s, so it was moved to the background (handle "${started.id}") to keep the turn responsive — it is STILL RUNNING. Poll it with getProcessOutput("${started.id}") and stop it with killProcess("${started.id}"). Don't just re-run it. If you need its result before replying, keep working on other things and check back, or use the wait tool.`,
    running: true,
    stderr: clip(result.stderr),
    stdout: clip(result.stdout),
  };
}

export function readFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Read a text file from the sandbox workspace. Returns null if the file does not exist.',
    inputSchema: z.object({
      endLine: z.number().int().min(1).optional(),
      path: z.string(),
      startLine: z.number().int().min(1).optional(),
    }),
    execute: async ({ endLine, path, startLine }) => {
      const context = getSandboxContext();
      const bytes = await context.session.readBinaryFile({
        path: resolvePath(context, path),
      });
      if (!bytes) {
        return { content: null, found: false };
      }
      let text = new TextDecoder().decode(bytes);
      if (startLine !== undefined || endLine !== undefined) {
        text = text
          .split('\n')
          .slice(Math.max((startLine ?? 1) - 1, 0), endLine)
          .join('\n');
      }
      return { content: clip(text), found: true };
    },
  });
}

export function writeFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Write a text file in the sandbox workspace (creates parent directories, overwrites existing content). Your reply — including this tool call — is capped at a few thousand tokens, so a single call CANNOT carry a very large file: content over roughly 400 lines gets cut off mid-argument. Write a big file in successive chunks instead — the first call with append:false, each following call with append:true.',
    inputSchema: z.object({
      append: z
        .boolean()
        .optional()
        .describe(
          'Append to the file instead of overwriting it. Use this to build a large file across several calls.'
        ),
      content: z.string(),
      path: z.string(),
    }),
    execute: async ({ append, content, path }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const existing = append
        ? await context.session.readBinaryFile({ path: resolved })
        : null;
      const next = existing
        ? `${new TextDecoder().decode(existing)}${content}`
        : content;
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(next),
        path: resolved,
      });
      return {
        appended: Boolean(append),
        bytes: next.length,
        path: resolved,
        written: true,
      };
    },
  });
}

export function editFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Edit a text file in the sandbox by exact string replacement. oldString must match the file contents exactly (including whitespace) and, unless replaceAll is true, exactly once.',
    inputSchema: z.object({
      newString: z.string(),
      oldString: z.string(),
      path: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async ({ newString, oldString, path, replaceAll }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        throw new Error(`File not found: ${resolved}`);
      }
      const text = new TextDecoder().decode(bytes);
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error('oldString was not found in the file.');
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString matches ${occurrences} times; make it unique or set replaceAll.`
        );
      }
      const updated = replaceAll
        ? text.replaceAll(oldString, newString)
        : text.replace(oldString, newString);
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(updated),
        path: resolved,
      });
      return { path: resolved, replaced: occurrences };
    },
  });
}
