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
// An absolute path in /tmp, /root, /home or ~ that the brief names.
const BRIEF_PATH =
  /(?:^|[\s'"`(=])((?:\/(?:tmp|root|home)|~(?=\/))(?:\/[^\s'"`),;]*)?)/g;
// The sandbox user's home, what `~` means in a brief.
const SANDBOX_HOME = '/home/user';
// Inside the sandbox's own 20-minute command limit, with room to clean up.
const RUN_TIMEOUT_SECONDS = 18 * 60;
// How much longer than the run the turn's stall watchdog must wait.
const WATCHDOG_GRACE_MS = 2 * 60 * 1000;
// One OpenCode at a time per sandbox. Two parallel calls (kyto building two
// projects at once) crashed OpenCode's first-run database migration and got
// one SIGKILLed for memory in the 1 GB sandbox. Taken inside the sandbox, so
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

// OpenCode's log line when its config refused a permission (e.g. a path
// outside its directory): "permission requested: external_directory (…);
// auto-rejecting".
const PERMISSION_REJECTED = /permission requested: .*auto-rejecting/;
// Colour codes OpenCode writes even when it is not on a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what they are
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Owner's call (2026-10-15): DeepSeek V4.1 Flash, now free on Zen. Only FREE
// models work here (no account key in the sandbox), and Zen serves them only
// to the OpenCode client — a plain API call gets `FreeTierError`.
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free';
// luna fills an optional string with "." — `opencode run --model .` dies with
// "Unexpected server error" before doing anything, and every run in a thread
// failed that way. Anything that isn't `provider/model` runs the default.
const MODEL_ID = /^[\w.-]+\/[\w./-]+$/;

// A media file made with command-line tools is a bash one-liner, and the
// description saying so wasn't enough: a two-frame GIF from three PNGs went to
// OpenCode for 185s of a six-minute turn (#110). A brief that names such tools
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
      "Delegate code work to OpenCode, a coding agent in your sandbox: writing, building, running, testing or debugging programs, scripts and projects. Use this instead of writing or running code yourself. NOT for producing a file with command-line tools (ImageMagick, ffmpeg, curl, converting or resizing, a one-off command): do that in bash yourself. Give it a complete, self-contained brief in YOUR OWN words: what to build or fix, where the files are, constraints, and what to report back. The sandbox has 1 GB of memory and a run that exhausts it is killed with its work lost, so ask for checks scoped to what changed (one package's typecheck, `bun test <file>`), not a whole big repo's typecheck plus full test suite. NEVER paste Slack messages, people's names or anything else from Slack into the brief (OpenCode's models may train on what they are sent). It works in the persistent thread sandbox, so files it writes are there for bash/uploadFile afterwards, and `continue: true` resumes its last session there. ONE run at a time per sandbox: never call it in parallel: for several projects, call once per project, one after another. Deliver the result as your own work; don't bring up OpenCode unless someone asks how it was done. If someone tells you NOT to use OpenCode, never quietly call it again: tell them code work on kyto's models has to go through it, and that adding their own model key or ChatGPT account (App Home → Models) lets you do it without OpenCode: then wait for their answer.",
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
        .optional()
        .describe(
          `An OpenCode model id. Leave unset for the default, ${DEFAULT_MODEL}.`
        ),
    }),
    execute: async (
      { brief, continue: resume, directory, model },
      { abortSignal }
    ) => {
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
      // "/home/user/home/user", and OpenCode then refused to touch the files
      // the brief named because they were outside its directory.
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
      // OpenCode auto-rejects every path outside its directory, and found out
      // only after a 78s run with `cd /tmp` in the brief (#82). Refused up front
      // so the model moves the files or uses bash instead.
      const outside = [
        ...new Set(
          [...brief.matchAll(BRIEF_PATH)]
            .map((match) => match[1] ?? '')
            .map((path) =>
              path.startsWith('~')
                ? nodePath.join(SANDBOX_HOME, path.slice(1))
                : nodePath.normalize(path)
            )
            .filter(
              (path) => path !== workDir && !path.startsWith(`${workDir}/`)
            )
        ),
      ];
      if (outside.length > 0) {
        return {
          error: `OpenCode can only touch files under ${workDir}, and the brief names ${outside.slice(0, 3).join(', ')}. Put the files under ${workDir} (or set \`directory\` to where they are, inside the workspace) and brief it again: or run a one-off command with bash instead.`,
          success: false,
        };
      }

      // Per call: parallel calls used to share one brief file and could run
      // each other's task.
      const runId = crypto.randomUUID();
      const briefPath = nodePath.join(
        context.sessionWorkDir,
        `.kyto/opencode-brief-${runId}.md`
      );
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(brief),
        path: briefPath,
      });

      const releaseDeadline = extendAttemptDeadline?.(
        RUN_TIMEOUT_SECONDS * 1000 + WATCHDOG_GRACE_MS
      );
      // The real Slack boundary for OpenCode (its providers may train on what
      // it reads): the token is switched off host-side for the run. The PATH
      // wrapper's `unset` alone left it readable in /proc/$PPID/environ.
      const resumeSlack = context.suspendSlack?.();
      let result: { exitCode: number; stderr: string; stdout: string };
      try {
        // fd 9 is closed for setup and OpenCode: a dev server OpenCode leaves
        // running would otherwise hold the lock for the sandbox's lifetime.
        // `timeout` puts OpenCode in its own process group, which E2B's kill
        // (the shell's pid only) never reaches — so the group is recorded too.
        result = await context.session.run({
          abortSignal,
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
            `( ${OPENCODE_SETUP_COMMAND}\n) 9>&- >"$SETUP_LOG" 2>&1 || { cat "$SETUP_LOG"; rm -f '${STATE_PATH}'; exit ${SETUP_FAILED_EXIT}; }`,
            `mkdir -p '${workDir}' && cd '${workDir}'`,
            `timeout ${RUN_TIMEOUT_SECONDS} opencode run --model '${model && MODEL_ID.test(model) ? model : DEFAULT_MODEL}' ${resume ? '--continue' : ''} "$(cat '${briefPath}')" 9>&- 2>&1 &`,
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
          error: `OpenCode is already running in this sandbox (started ${Math.round(heldFor / 60)} min ago, probably by an earlier turn); a run is cleared automatically after ${STALE_SECONDS / 60} min, so in ~${Math.ceil(clearsIn / 60)} min at most. Do NOT poll it with wait: tell the person it's busy and when it frees up, or do other work. One run at a time (put several projects in one brief, or call once per project, one after another).`,
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
      // OpenCode exits 0 after refusing a permission, so the run looked like
      // a success that had silently done nothing.
      const rejected = PERMISSION_REJECTED.test(output);
      const note = rejected
        ? 'OpenCode refused to touch something outside its working directory, so that part was NOT done. Call again with `directory` set to where the files are (a path inside the workspace), or with paths relative to it.'
        : notes[result.exitCode];
      return {
        directory: workDir,
        exitCode: result.exitCode,
        // The END is what matters — OpenCode closes with its own summary.
        output:
          output.length > OUTPUT_MAX
            ? `…${output.slice(-OUTPUT_MAX)}`
            : output || '(no output)',
        success: result.exitCode === 0 && !rejected,
        ...(note ? { note } : {}),
      };
    },
  });
}
