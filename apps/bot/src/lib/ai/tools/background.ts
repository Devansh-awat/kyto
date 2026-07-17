import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// There is no native background/detached-process concept in the sandbox
// (session.run is a single blocking call), so this is built on top of it with a
// standard nohup-and-log trick: start the command detached, capture its pid and
// its stdout/stderr/exit-code into files, and let follow-up calls poll them.
// Handles are tracked in-memory for the life of this turn's tool-closure
// (buildTools() runs fresh per turn) — no persistence, consistent with the
// sandbox's no-persistence policy: once the turn's session is destroyed, any
// still-running background process goes with it.
//
// The same registry backs the `bash` tool's AUTO-BACKGROUNDING: a foreground
// command that runs longer than a minute is handed off here so the turn doesn't
// freeze waiting on it (see sandbox.ts).
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

// Single-quote a string for safe embedding as one argument to the outer shell.
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface BackgroundProcess {
  errPath: string;
  exitPath: string;
  outPath: string;
  pid: string;
}

export interface ManagedResult {
  exitCode?: number;
  finished: boolean;
  stderr: string;
  stdout: string;
}

const POLL_STEPS_MS = [250, 500, 1000, 2000];

// The registry's shape (including the `startManaged`/`waitManaged` helpers the
// bash tool uses) is inferred from the return below — see the exported type.
export function backgroundProcessTools({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  const processes = new Map<string, BackgroundProcess>();
  let counter = 0;

  async function startManaged(
    command: string,
    workingDirectory?: string
  ): Promise<{ id: string } | { error: string }> {
    const context = getSandboxContext();
    counter += 1;
    const id = `bg-${counter}`;
    const base = `${context.sessionWorkDir}/.kyto-bg-${id}`;
    const proc: BackgroundProcess = {
      errPath: `${base}.err`,
      exitPath: `${base}.exit`,
      outPath: `${base}.out`,
      pid: '',
    };
    // Run the command under an inner sh, capturing stdout/stderr/exit-code into
    // files, all detached via nohup so it outlives this run() call. The exit
    // file is written only AFTER the command completes, so its presence is how a
    // poll knows the job finished. Single-quoting keeps the outer shell from
    // expanding anything in the user command ($?, $! stay for the inner sh).
    const wrapped = `{ ${command}\n} >"${proc.outPath}" 2>"${proc.errPath}"; echo $? >"${proc.exitPath}"`;
    const launch = `nohup sh -c ${shSingleQuote(wrapped)} >/dev/null 2>&1 & echo $!`;
    const result = await context.session.run({
      command: launch,
      workingDirectory: workingDirectory ?? context.sessionWorkDir,
    });
    const pid = result.stdout.trim();
    if (!pid) {
      return {
        error: `Failed to start background process: ${result.stderr.trim()}`,
      };
    }
    proc.pid = pid;
    processes.set(id, proc);
    return { id };
  }

  async function readManaged(id: string): Promise<ManagedResult | null> {
    const context = getSandboxContext();
    const proc = processes.get(id);
    if (!proc) {
      return null;
    }
    const [out, err, exit] = await Promise.all([
      context.session.run({
        command: `cat "${proc.outPath}" 2>/dev/null || true`,
      }),
      context.session.run({
        command: `cat "${proc.errPath}" 2>/dev/null || true`,
      }),
      context.session.run({
        command: `cat "${proc.exitPath}" 2>/dev/null || true`,
      }),
    ]);
    const exitText = exit.stdout.trim();
    const finished = exitText !== '';
    const exitCode = finished ? Number.parseInt(exitText, 10) : undefined;
    return {
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      finished,
      stderr: err.stdout,
      stdout: out.stdout,
    };
  }

  async function waitManaged(
    id: string,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<ManagedResult> {
    const deadline = Date.now() + timeoutMs;
    let step = 0;
    let last: ManagedResult = { finished: false, stderr: '', stdout: '' };
    while (Date.now() < deadline) {
      abortSignal?.throwIfAborted();
      const result = await readManaged(id);
      if (!result) {
        return last;
      }
      last = result;
      if (result.finished) {
        return result;
      }
      const wait = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)];
      step += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return last;
  }

  const runBackgroundProcess = tool({
    description:
      'Start a shell command running in the background in the sandbox and return immediately with a handle id, instead of waiting for it to finish. Use getProcessOutput to check on it and killProcess to stop it.',
    inputSchema: z.object({
      command: z.string().min(1),
    }),
    execute: async ({ command }) => {
      try {
        const started = await startManaged(command);
        if ('error' in started) {
          return { error: started.error, success: false };
        }
        return {
          id: started.id,
          success: true,
          summary: `Started background process ${started.id}.`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const getProcessOutput = tool({
    description:
      'Read the output so far of a background process (started with runBackgroundProcess, or a bash command that was auto-moved to the background after running over a minute), and whether it is still running. Reports the exit code once finished.',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        const result = await readManaged(id);
        if (!result) {
          return { error: `Unknown process id: ${id}`, success: false };
        }
        return {
          exitCode: result.exitCode,
          id,
          running: !result.finished,
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: true,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const killProcess = tool({
    description:
      'Kill a background process (started with runBackgroundProcess or auto-moved from bash).',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        const context = getSandboxContext();
        const proc = processes.get(id);
        if (!proc) {
          return { error: `Unknown process id: ${id}`, success: false };
        }
        // Kill the whole process group the launcher started, so children of the
        // command die too, then forget the handle.
        await context.session.run({
          command: `kill -9 -${proc.pid} 2>/dev/null || kill -9 ${proc.pid} 2>/dev/null || true`,
        });
        processes.delete(id);
        return { success: true, summary: `Killed process ${id}.` };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  return {
    getProcessOutput,
    killProcess,
    runBackgroundProcess,
    startManaged,
    waitManaged,
  };
}

export type BackgroundProcessTools = ReturnType<typeof backgroundProcessTools>;
