import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { CODING_AGENT_SETUP_COMMAND } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import {
  codeModelConfigured,
  registerCodeModelToken,
} from '@/lib/code-model-proxy';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clamp } from '@/lib/utils/text';

// Hand code work to a coding agent in the thread's sandbox, off Hack Club AI's
// key (owner's call, 2026-09-29). The tool keeps its `opencode` name — prompts,
// the anti-coding redirect and every thread's stored tool list say it — but
// since 2026-10-19 the agent is Crush on the owner's router, reached through
// lib/code-model-proxy (packages/sandbox/src/coding-agent.ts says why).
//
// kyto itself stays a non-coding agent on Hack Club AI's key — the prompt says
// so and the anti-coding check (lib/anti-coding) still watches its own code
// tools. This tool is deliberately NOT one of those: the writing, building and
// running happen in the agent, off Hack Club AI, and that is the point of it.
//
// The agent never reaches Slack, because its model's provider may train on
// what it is sent.

// The agent is a sixth way to run commands in the sandbox, next to bash, gh,
// codeMode, runBackgroundProcess and slackScript. GitHub needs nothing extra
// (its writes go through the host proxy, which guards them as this turn's
// person), but a repo it clones must be disarmed exactly like codeMode's: the
// commands it ran are invisible from here, so unconditionally.
const OUTPUT_MAX = 12_000;
// Inside the sandbox's own 20-minute command limit, with room to clean up.
const RUN_TIMEOUT_SECONDS = 18 * 60;
const MAX_RUN_MINUTES = RUN_TIMEOUT_SECONDS / 60;
// Files a stopped run touched, listed so kyto sees how far it got: `crush run
// -q` prints only when it ends, so a timed-out run used to come back as
// "(no output)" and was re-run blind for another 18 minutes (#124).
const CHANGED_FILES_MAX = 30;
// How much longer than the run the turn's stall watchdog must wait.
const WATCHDOG_GRACE_MS = 2 * 60 * 1000;
// One run at a time per sandbox. Two parallel OpenCode calls (kyto building
// two projects at once) crashed its database migration and got one SIGKILLed
// for memory in the 1 GB sandbox, and two agents in one directory would edit
// each other's files. Taken inside the sandbox, so
// it holds across turns, threads sharing a code channel's sandbox, and bash.
const LOCK_PATH = '/home/user/.kyto/opencode.lock';
// The lock holder: `<started epoch> <run id> <shell pid> <process group>`.
// `timeout` counts on the sandbox's monotonic clock, which stops while it is
// paused — a run left going when its turn ended was frozen at each pause and
// woke for seconds per turn, so it held the lock for over an hour (verified
// 2026-10-03). The wall clock is synced on resume, so it decides staleness,
// and an aborted run is killed before the pause (`onAbortCommand`).
const STATE_PATH = '/home/user/.kyto/opencode.run';
const STALE_SECONDS = RUN_TIMEOUT_SECONDS + WATCHDOG_GRACE_MS / 1000;
const BUSY_EXIT = 75;
const SETUP_FAILED_EXIT = 76;
const KILLED_EXIT = 137;

// Colour codes the agent may write even when it is not on a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what they are
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// The one model the crushrc defines; the proxy maps it to CODE_MODEL.
const AGENT_MODEL = 'kyto/kyto-code';

// A media file made with command-line tools is a bash one-liner, and the
// description saying so wasn't enough: a two-frame GIF from three PNGs went to
// the coding agent for 185s of a six-minute turn (#110). A brief that names such tools
// and nothing project-shaped is sent back ONCE per turn; the same call again
// runs, so real code work that happens to mention ffmpeg is never stuck.
const MEDIA_TOOLS =
  /\b(?:imagemagick|magick|ffmpeg|ffprobe|gifsicle|sox|exiftool|pngquant|cwebp)\b/i;
const MEDIA_FILE = /\b(?:gif|png|jpe?g|webp|mp4|mp3|wav|webm|mov|svg)s?\b/i;
const MEDIA_EDIT =
  /\b(?:convert|resize|crop|composite|compose|overlay|frames?|loop|trim|transcode|compress|rotate)\b/i;
const PROJECT_WORK =
  /\b(?:repo|repository|project|app|application|bot|server|website|library|package\.json|compile|tests?|mod|plugin|cli|api|endpoint|class|function|module)\b/i;

export function isMediaOnlyBrief(brief: string): boolean {
  const media =
    MEDIA_TOOLS.test(brief) ||
    (MEDIA_FILE.test(brief) && MEDIA_EDIT.test(brief));
  return media && !PROJECT_WORK.test(brief);
}

export function opencodeTool({
  extendAttemptDeadline,
  getSandboxContext,
}: {
  extendAttemptDeadline?: (extraMs: number) => () => void;
  getSandboxContext: () => SandboxContext;
}) {
  let mediaSentBack = false;
  return tool({
    description:
      "Delegate code work to the coding agent in your sandbox: writing, building, running, testing or debugging programs, scripts and projects. Use this instead of writing or running code yourself. NOT for producing a file with command-line tools (ImageMagick, ffmpeg, curl, converting or resizing, a one-off command): do that in bash yourself. Give it a complete, self-contained brief in YOUR OWN words: what to build or fix, where the files are, constraints, and what to report back. The sandbox has 1 GB of memory and a run that exhausts it is killed, so close any browser you opened before calling it, and ask for checks scoped to what changed (one package's typecheck, one test file), not a whole big repo's typecheck plus full test suite. NEVER paste Slack messages, people's names or anything else from Slack into the brief (its model may train on what it is sent). It works in the persistent thread sandbox, so files it writes are there for bash/uploadFile afterwards, and `continue: true` resumes its last session in that directory. ONE run at a time per sandbox: never call it in parallel: for several projects, call once per project, one after another. Deliver the result as your own work; don't bring up the coding agent unless someone asks how it was done. If someone tells you NOT to use it, never quietly call it again: tell them code work on kyto's models has to go through it, and that adding their own model key or ChatGPT account (App Home → Models) lets you do it yourself: then wait for their answer.",
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
          "Resume the agent's previous session in this directory instead of starting fresh."
        ),
      directory: z
        .string()
        .optional()
        .describe(
          'Working directory, relative to the sandbox workspace (created if missing). Defaults to the workspace itself.'
        ),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(MAX_RUN_MINUTES)
        .optional()
        .describe(
          `Wall-clock limit for this run, in minutes (default and maximum ${MAX_RUN_MINUTES}). Set it from the person's own deadline, leaving room to check and report.`
        ),
    }),
    execute: async (
      { brief, continue: resume, directory, minutes },
      { abortSignal }
    ) => {
      if (!codeModelConfigured()) {
        return {
          error:
            'The coding agent has no model configured right now, so code work cannot run. Tell the person code work is unavailable at the moment; do not try to write or run the code yourself.',
          success: false,
        };
      }
      if (!(mediaSentBack || resume) && isMediaOnlyBrief(brief)) {
        mediaSentBack = true;
        return {
          error:
            'Not run: this brief makes or converts a media file with command-line tools, which you do yourself in bash: usually one command, seconds instead of minutes here. Run it with bash now (check the result, e.g. `identify` or `ffprobe`, then upload it). Only if it truly needs a program written and kept, call opencode again with the same brief and it will run.',
          success: false,
        };
      }
      const context = getSandboxContext();
      // resolve, not join: an absolute "/home/user" was joined into
      // "/home/user/home/user".
      const workDir = nodePath.resolve(
        context.sessionWorkDir,
        directory ?? '.'
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
      const runId = crypto.randomUUID();
      const briefPath = nodePath.join(
        context.sessionWorkDir,
        `.kyto/agent-brief-${runId}.md`
      );
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(brief),
        path: briefPath,
      });

      const runSeconds = (minutes ?? MAX_RUN_MINUTES) * 60;
      const startedAt = Math.floor(Date.now() / 1000);
      const releaseDeadline = extendAttemptDeadline?.(
        runSeconds * 1000 + WATCHDOG_GRACE_MS
      );
      // The real Slack boundary for the agent (its model's provider may train
      // on what it reads): the token is switched off host-side for the run. The
      // PATH wrapper's `unset` alone left it readable in /proc/$PPID/environ.
      const resumeSlack = context.suspendSlack?.();
      const model = registerCodeModelToken();
      let result: { exitCode: number; stderr: string; stdout: string };
      try {
        // fd 9 is closed for setup and the agent: a dev server it leaves
        // running would otherwise hold the lock for the sandbox's lifetime.
        // `timeout` puts the agent in its own process group, which E2B's kill
        // (the shell's pid only) never reaches — so the group is recorded too.
        result = await context.session.run({
          abortSignal,
          env: model.env,
          command: [
            `mkdir -p "$(dirname '${LOCK_PATH}')"`,
            `exec 9>'${LOCK_PATH}'`,
            'if ! flock -n 9; then',
            `  read -r started _ shell group 2>/dev/null < '${STATE_PATH}' || started=''`,
            `  if [ -z "$started" ] || [ $(( $(date +%s) - started )) -lt ${STALE_SECONDS} ]; then echo "held_for=$(( $(date +%s) - \${started:-$(date +%s)} ))"; exit ${BUSY_EXIT}; fi`,
            '  kill -KILL -- "$shell" 2>/dev/null; [ -n "$group" ] && kill -KILL -- "-$group" 2>/dev/null',
            `  flock -w 10 9 || exit ${BUSY_EXIT}`,
            'fi',
            // Holding the lock, a recorded group is a killed run's leftover.
            `if read -r _ _ _ group 2>/dev/null < '${STATE_PATH}' && [ -n "$group" ]; then kill -KILL -- "-$group" 2>/dev/null; fi`,
            `echo "$(date +%s) ${runId} $$" > '${STATE_PATH}'`,
            'SETUP_LOG=$(mktemp)',
            `( ${CODING_AGENT_SETUP_COMMAND}\n) 9>&- >"$SETUP_LOG" 2>&1 || { cat "$SETUP_LOG"; rm -f '${STATE_PATH}'; exit ${SETUP_FAILED_EXIT}; }`,
            `mkdir -p '${workDir}' && cd '${workDir}'`,
            `timeout ${runSeconds} crush run -q ${resume ? '-C' : ''} -m '${AGENT_MODEL}' "$(cat '${briefPath}')" 9>&- 2>&1 &`,
            'RUN_PID=$!',
            `echo "$(date +%s) ${runId} $$ $RUN_PID" > '${STATE_PATH}'`,
            'wait "$RUN_PID"',
            'CODE=$?',
            `rm -f '${STATE_PATH}'`,
            'exit "$CODE"',
          ].join('\n'),
          onAbortCommand: `if read -r _ id shell group 2>/dev/null < '${STATE_PATH}' && [ "$id" = '${runId}' ]; then kill -KILL -- "$shell" 2>/dev/null; [ -n "$group" ] && kill -KILL -- "-$group" 2>/dev/null; rm -f '${STATE_PATH}'; fi`,
        });
      } finally {
        model.revoke();
        resumeSlack?.();
        releaseDeadline?.();
        // Best-effort: a leftover brief must not turn a finished run into an error.
        await Promise.resolve(
          context.session.run({ command: `rm -f '${briefPath}'` })
        ).catch(() => undefined);
      }
      await disarmFetchedRepos({ abortSignal, context });

      const output = (result.stdout + result.stderr).replace(ANSI, '').trim();
      if (result.exitCode === BUSY_EXIT) {
        // Without the age a turn polled with `wait` for 25 minutes behind a
        // run an earlier turn had started (#24).
        const heldFor = Number(/held_for=(\d+)/.exec(output)?.[1] ?? 0);
        const clearsIn = Math.max(0, STALE_SECONDS - heldFor);
        return {
          error: `The coding agent is already running in this sandbox (started ${Math.round(heldFor / 60)} min ago, probably by an earlier turn); a run is cleared automatically after ${STALE_SECONDS / 60} min, so in ~${Math.ceil(clearsIn / 60)} min at most. Do NOT poll it with wait: tell the person it's busy and when it frees up, or do other work. One run at a time (put several projects in one brief, or call once per project, one after another).`,
          success: false,
        };
      }
      if (result.exitCode === SETUP_FAILED_EXIT) {
        return {
          error: `The coding agent could not be set up: ${clamp(output, 2000)}`,
          success: false,
        };
      }
      const notes: Record<number, string> = {
        124: `The coding agent was stopped after ${runSeconds / 60} minutes. Its work so far is in the directory (changedFiles); call again with continue: true to pick up. If the work is a long-running job (a benchmark, a solver loop), don't hand it the run again: have it finish and smoke-test the program, then run that yourself with runBackgroundProcess.`,
        [KILLED_EXIT]:
          'The coding agent was killed, most likely out of memory (the sandbox has 1 GB). Its work so far is in the directory. Free memory first (close the browser, stop dev servers and background jobs), then call again with continue: true.',
      };
      const note = notes[result.exitCode];
      const changed =
        result.exitCode === 124
          ? await Promise.resolve(
              context.session.run({
                command: `find '${workDir}' -type f -newermt '@${startedAt}' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.kyto/*' 2>/dev/null | head -${CHANGED_FILES_MAX}`,
              })
            )
              .then((listed) =>
                listed.stdout
                  .split('\n')
                  .filter(Boolean)
                  .map((path) => nodePath.relative(workDir, path))
              )
              .catch(() => undefined)
          : undefined;
      return {
        directory: workDir,
        exitCode: result.exitCode,
        // The END is what matters — the agent closes with its own summary.
        output:
          output.length > OUTPUT_MAX
            ? `…${output.slice(-OUTPUT_MAX)}`
            : output || '(no output)',
        success: result.exitCode === 0,
        ...(changed ? { changedFiles: changed } : {}),
        ...(note ? { note } : {}),
      };
    },
  });
}
