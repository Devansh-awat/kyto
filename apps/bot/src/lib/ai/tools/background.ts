import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// There is no native background/detached-process concept in the harness's
// ExecutionEnv (Shell.exec is a single blocking call), so this is built on
// top of it with a standard nohup-and-log trick: start the command detached,
// capture its pid, and let follow-up calls poll the log file / pid liveness.
// Handles are tracked in-memory for the life of this turn's tool-closure
// (buildTools() is called fresh per turn in agent/index.ts) — no persistence,
// consistent with the sandbox's own no-persistence policy: once the turn's
// session is destroyed, any still-running background process goes with it.
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

interface BackgroundProcess {
  logPath: string;
  pid: string;
}

export function backgroundProcessTools({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  const processes = new Map<string, BackgroundProcess>();
  let counter = 0;

  function requireContext(): SandboxContext {
    const context = getSandboxContext();
    if (!context) {
      throw new Error('No active sandbox session is available.');
    }
    return context;
  }

  const runBackgroundProcess = tool({
    description:
      'Start a shell command running in the background in the sandbox and return immediately with a handle id, instead of waiting for it to finish. Use getProcessOutput to check on it and killProcess to stop it.',
    inputSchema: z.object({
      command: z.string().min(1),
    }),
    execute: async ({ command }) => {
      try {
        const context = requireContext();
        const id = `bg-${++counter}`;
        const logPath = `${context.sessionWorkDir}/.kyto-bg-${id}.log`;
        const result = await context.session.run({
          command: `nohup sh -c ${JSON.stringify(command)} > ${JSON.stringify(logPath)} 2>&1 & echo $!`,
          workingDirectory: context.sessionWorkDir,
        });
        const pid = result.stdout.trim();
        if (!pid) {
          return {
            success: false,
            error: `Failed to start background process: ${result.stderr.trim()}`,
          };
        }
        processes.set(id, { pid, logPath });
        return {
          success: true,
          id,
          pid,
          summary: `Started background process ${id} (pid ${pid}).`,
        };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  });

  const getProcessOutput = tool({
    description:
      'Read the output so far of a background process started with runBackgroundProcess, and whether it is still running.',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        const context = requireContext();
        const proc = processes.get(id);
        if (!proc) {
          return { success: false, error: `Unknown process id: ${id}` };
        }
        const [output, alive] = await Promise.all([
          context.session.run({
            command: `cat ${JSON.stringify(proc.logPath)} 2>/dev/null || true`,
          }),
          context.session.run({
            command: `kill -0 ${proc.pid} 2>/dev/null && echo alive || echo dead`,
          }),
        ]);
        return {
          success: true,
          id,
          running: alive.stdout.trim() === 'alive',
          output: truncate(output.stdout),
        };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  });

  const killProcess = tool({
    description: 'Kill a background process started with runBackgroundProcess.',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        const context = requireContext();
        const proc = processes.get(id);
        if (!proc) {
          return { success: false, error: `Unknown process id: ${id}` };
        }
        await context.session.run({
          command: `kill -9 ${proc.pid} 2>/dev/null || true`,
        });
        processes.delete(id);
        return { success: true, summary: `Killed process ${id}.` };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  });

  return { runBackgroundProcess, getProcessOutput, killProcess };
}
