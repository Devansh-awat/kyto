import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { OPENCODE_SETUP_COMMAND } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clamp } from '@/lib/utils/text';

// Hand code work to OpenCode, a coding agent running in the thread's sandbox on
// its own free models (owner's call, 2026-09-29).
//
// kyto itself stays a non-coding agent on Hack Club AI's key — the prompt says
// so and the anti-coding check (lib/anti-coding) still watches its own code
// tools. This tool is deliberately NOT one of those: the writing, building and
// running happen in OpenCode, off Hack Club AI, and that is the point of it.
//
// OpenCode never reaches Slack (see packages/sandbox/src/opencode.ts for how),
// because its free models' providers may train on what they are sent.

// OpenCode is a sixth way to run commands in the sandbox, next to bash, gh,
// codeMode, runBackgroundProcess and slackScript. GitHub needs nothing extra
// (its writes go through the host proxy, which guards them as this turn's
// person), but a repo it clones must be disarmed exactly like codeMode's: the
// commands it ran are invisible from here, so unconditionally.
const OUTPUT_MAX = 12_000;
// Inside the sandbox's own 20-minute command limit, with room to clean up.
const RUN_TIMEOUT_SECONDS = 18 * 60;
// How much longer than the run the turn's stall watchdog must wait.
const WATCHDOG_GRACE_MS = 2 * 60 * 1000;
// One OpenCode at a time per sandbox. Two parallel calls (kyto building two
// projects at once) crashed OpenCode's first-run database migration and got
// one SIGKILLed for memory in the 1 GB sandbox. Taken inside the sandbox, so
// it holds across turns, threads sharing a code channel's sandbox, and bash.
const LOCK_PATH = '/home/user/.kyto/opencode.lock';
const BUSY_EXIT = 75;
const SETUP_FAILED_EXIT = 76;
const KILLED_EXIT = 137;

// Colour codes OpenCode writes even when it is not on a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what they are
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Owner's call (2026-09-30): Big Pickle, OpenCode's own free default. Only
// FREE models work here (no account key in the sandbox); the free DeepSeek
// (`opencode/deepseek-v4-flash-free`) was answering "Model is unavailable".
const DEFAULT_MODEL = 'opencode/big-pickle';

export function opencodeTool({
  extendAttemptDeadline,
  getSandboxContext,
}: {
  extendAttemptDeadline?: (extraMs: number) => () => void;
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      "Delegate code work to OpenCode, a coding agent in your sandbox: writing, building, running, testing or debugging programs, scripts and projects. Use this instead of writing or running code yourself. Give it a complete, self-contained brief in YOUR OWN words — what to build or fix, where the files are, constraints, and what to report back. NEVER paste Slack messages, people's names or anything else from Slack into the brief (OpenCode's models may train on what they are sent). It works in the persistent thread sandbox, so files it writes are there for bash/uploadFile afterwards, and `continue: true` resumes its last session there. ONE run at a time per sandbox: never call it in parallel — for several projects, call once per project, one after another. Deliver the result as your own work; don't bring up OpenCode unless someone asks how it was done.",
    inputSchema: z.object({
      brief: z
        .string()
        .min(1)
        .describe(
          'The task, fully self-contained, in your own words. No Slack content.'
        ),
      continue: z
        .boolean()
        .optional()
        .describe(
          "Resume OpenCode's previous session in this directory instead of starting fresh."
        ),
      directory: z
        .string()
        .optional()
        .describe(
          'Working directory, relative to the sandbox workspace (created if missing). Defaults to the workspace itself.'
        ),
      model: z
        .string()
        .regex(/^[\w./-]+$/)
        .optional()
        .describe(
          `An OpenCode model id. Leave unset for the default, ${DEFAULT_MODEL}.`
        ),
    }),
    execute: async (
      { brief, continue: resume, directory, model },
      { abortSignal }
    ) => {
      const context = getSandboxContext();
      const workDir = nodePath.normalize(
        nodePath.join(context.sessionWorkDir, directory ?? '.')
      );
      if (
        workDir !== context.sessionWorkDir &&
        !workDir.startsWith(`${context.sessionWorkDir}/`)
      ) {
        return {
          error: 'directory must be inside the sandbox workspace.',
          success: false,
        };
      }

      // Per call: parallel calls used to share one brief file and could run
      // each other's task.
      const briefPath = nodePath.join(
        context.sessionWorkDir,
        `.kyto/opencode-brief-${crypto.randomUUID()}.md`
      );
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(brief),
        path: briefPath,
      });

      const releaseDeadline = extendAttemptDeadline?.(
        RUN_TIMEOUT_SECONDS * 1000 + WATCHDOG_GRACE_MS
      );
      let result: { exitCode: number; stderr: string; stdout: string };
      try {
        // fd 9 is closed for setup and OpenCode: a dev server OpenCode leaves
        // running would otherwise hold the lock for the sandbox's lifetime.
        result = await context.session.run({
          abortSignal,
          command: [
            `mkdir -p "$(dirname '${LOCK_PATH}')"`,
            `exec 9>'${LOCK_PATH}'`,
            `flock -n 9 || exit ${BUSY_EXIT}`,
            'SETUP_LOG=$(mktemp)',
            `( ${OPENCODE_SETUP_COMMAND}\n) 9>&- >"$SETUP_LOG" 2>&1 || { cat "$SETUP_LOG"; exit ${SETUP_FAILED_EXIT}; }`,
            `mkdir -p '${workDir}' && cd '${workDir}'`,
            `timeout ${RUN_TIMEOUT_SECONDS} opencode run --model '${model ?? DEFAULT_MODEL}' ${resume ? '--continue' : ''} "$(cat '${briefPath}')" 9>&- 2>&1`,
          ].join('\n'),
        });
      } finally {
        releaseDeadline?.();
        // Best-effort: a leftover brief must not turn a finished run into an error.
        await Promise.resolve(
          context.session.run({ command: `rm -f '${briefPath}'` })
        ).catch(() => undefined);
      }
      await disarmFetchedRepos({ abortSignal, context });

      const output = (result.stdout + result.stderr).replace(ANSI, '').trim();
      if (result.exitCode === BUSY_EXIT) {
        return {
          error:
            'OpenCode is already running in this sandbox. Wait for that run to finish, then call again — one run at a time (put several projects in one brief, or call once per project, one after another).',
          success: false,
        };
      }
      if (result.exitCode === SETUP_FAILED_EXIT) {
        return {
          error: `OpenCode could not be set up: ${clamp(output, 2000)}`,
          success: false,
        };
      }
      const notes: Record<number, string> = {
        124: `OpenCode was stopped after ${RUN_TIMEOUT_SECONDS / 60} minutes. Its work so far is in the directory; call again with continue: true to pick up.`,
        [KILLED_EXIT]:
          'OpenCode was killed, most likely out of memory (the sandbox has 1 GB). Its work so far is in the directory; call again with continue: true, and stop any dev servers left running first.',
      };
      const note = notes[result.exitCode];
      return {
        directory: workDir,
        exitCode: result.exitCode,
        // The END is what matters — OpenCode closes with its own summary.
        output:
          output.length > OUTPUT_MAX
            ? `…${output.slice(-OUTPUT_MAX)}`
            : output || '(no output)',
        success: result.exitCode === 0,
        ...(note ? { note } : {}),
      };
    },
  });
}
