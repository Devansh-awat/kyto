import type { SandboxContext } from '@repo/ai';
import { mayHaveFetchedRepo } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { parseGithubCommand } from '@/lib/github/command';
import { guardGithubCommand } from '@/lib/github/guard';
import logger from '@/lib/logger';
import { disarmFetchedRepos } from '@/lib/sandbox/git-safety';
import { clipOutput, fullOutputPath } from '@/lib/sandbox/output-clip';
import { errorMessage } from '@/lib/utils/error';

/**
 * The GitHub ownership gate for a backgrounded command, or undefined to proceed.
 *
 * A detached command outlives the turn that started it, so there is no principal
 * to check LATER — it has to be checked here, at start time, against the person
 * whose turn this is. Where there is no such person (a reminder job runs with no
 * principal at all) a mutating GitHub command is REFUSED rather than allowed:
 * kyto has one GitHub identity, and an unattended context cannot consent to a
 * write on somebody's behalf.
 */
async function guardBackgroundGithub({
  command,
  github,
}: {
  command: string;
  github?: { isOwner: boolean; threadId: string; userId: string };
}): Promise<string | undefined> {
  if (!github) {
    return parseGithubCommand(command).mutating
      ? 'Not allowed: this context has no user to attribute a GitHub write to, so a mutating GitHub command cannot run in the background here. Run it in the foreground of a real turn.'
      : undefined;
  }
  const guard = await guardGithubCommand({
    command,
    isOwner: github.isOwner,
    threadId: github.threadId,
    userId: github.userId,
  });
  return guard.allowed === false ? guard.reason : undefined;
}

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
// A polled process is exactly where the OLD head-only cut hurt most: a long
// build's verdict is its LAST line, and `…(truncated)` after the first 8k chars
// threw it away while looking like the command had simply said that much. Both
// ends are kept now, with the full text saved in the sandbox — see
// lib/sandbox/output-clip.
async function clipManaged(
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

// Single-quote a string for safe embedding as one argument to the outer shell.
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface BackgroundProcess {
  /** Set once the model has seen it finished, so no wake repeats it. */
  collected?: boolean;
  command: string;
  errPath: string;
  exitPath: string;
  outPath: string;
  pid: string;
  /** A host-side watcher is polling it (see startWatching). */
  watching?: boolean;
}

// Per THREAD, not per turn: a job outlives the turn that started it, and the
// next turn (a wake, or someone asking "is it done?") got "Unknown process id"
// for a job that was still running. In memory: a restart loses them, as it
// loses the sandbox's own process.
const threadProcesses = new Map<
  string,
  { counter: number; processes: Map<string, BackgroundProcess> }
>();

// How long a job may keep the sandbox awake after its turn ended, before kyto
// is told time's up (owner's call 2026-10-08: 30 min, then kyto decides).
const WATCH_AFTER_TURN_MS = 30 * 60 * 1000;
const WATCH_POLL_MS = 20 * 1000;
// A wake turn that starts or re-checks a job may be woken again, but not
// forever: a model re-arming every half hour would run all day.
const MAX_WAKE_CHAIN = 3;
const WAKE_ID = /^process-report-(\d+)-/;
const WAKE_QUIET_MAX_MS = 15 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 3000;

export interface ProcessWake {
  asUserAccount: boolean;
  message: Message;
  thread: ThreadHandle;
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
  github,
  wake,
}: {
  getSandboxContext: () => SandboxContext;
  /**
   * Who to wake when a job finishes after its turn (or runs 30 minutes past
   * it). Absent for unattended runs (a reminder, Kevinton): nobody to tell.
   */
  wake?: ProcessWake;
  /**
   * The principal this turn acts for, so a backgrounded command is gated on
   * repo ownership like any other shell. Omitted only where there is no
   * principal to check (a reminder job): a command with no `github` is NOT
   * exempt — see the guard call in `process` (action `start`).
   */
  github?: { isOwner: boolean; threadId: string; userId: string };
}) {
  const registry = (() => {
    const fresh = () => ({
      counter: 0,
      processes: new Map<string, BackgroundProcess>(),
    });
    const key = wake?.thread.id;
    if (!key) {
      return fresh();
    }
    const existing = threadProcesses.get(key) ?? fresh();
    threadProcesses.set(key, existing);
    return existing;
  })();
  const processes = registry.processes;
  // Commands still to be checked for a repo they may have fetched; a detached
  // command finishes out of band, so the disarm happens when a poll first sees
  // it done rather than at start time.
  const pendingDisarm = new Map<string, string>();

  async function startManaged(
    command: string,
    workingDirectory?: string
  ): Promise<{ id: string } | { error: string }> {
    const context = getSandboxContext();
    registry.counter += 1;
    const id = `bg-${registry.counter}`;
    // The sandbox (and its workdir) is the thread's and outlives a restart's
    // in-memory counter, so `bg-1` after a restart found the old `bg-1`'s exit
    // file and reported "finished" with its result. The files get a nonce.
    const base = `${context.sessionWorkDir}/.kyto-bg-${id}-${crypto.randomUUID().slice(0, 8)}`;
    const proc: BackgroundProcess = {
      command,
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
    if (mayHaveFetchedRepo(command)) {
      pendingDisarm.set(id, command);
    }
    return { id };
  }

  /** Strip hooks from anything a finished background command fetched. */
  async function disarmIfFinished(
    id: string,
    result: ManagedResult
  ): Promise<void> {
    const command = pendingDisarm.get(id);
    if (!(command && result.finished)) {
      return;
    }
    pendingDisarm.delete(id);
    await disarmFetchedRepos({ command, context: getSandboxContext() });
  }

  async function readManaged(
    id: string,
    context: SandboxContext = getSandboxContext()
  ): Promise<ManagedResult | null> {
    const proc = processes.get(id);
    if (!proc) {
      return null;
    }
    // Do this in ONE sandbox command. `commands.run()` calls against one E2B
    // session are not a safe concurrent transport: the old Promise.all could
    // return one stream from a different poll while another was still being
    // copied, which surfaced as mysteriously missing stdout. The completion
    // marker is written after both streams, so a single, ordered snapshot also
    // preserves the finished-command invariant.
    const snapshot = await context.session.run({
      command: `for path in "${proc.outPath}" "${proc.errPath}" "${proc.exitPath}"; do base64 -w0 "$path" 2>/dev/null || true; printf '\n'; done`,
    });
    const [stdout64 = '', stderr64 = '', exit64 = ''] =
      snapshot.stdout.split('\n');
    const stdout = Buffer.from(stdout64, 'base64').toString();
    const stderr = Buffer.from(stderr64, 'base64').toString();
    const exitText = Buffer.from(exit64, 'base64').toString().trim();
    const finished = exitText !== '';
    const exitCode = finished ? Number.parseInt(exitText, 10) : undefined;
    return {
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      finished,
      stderr,
      stdout,
    };
  }

  /**
   * Keep an eye on a job once its turn is over: when it finishes, wake the
   * thread with the result; 30 minutes after the turn, wake it to say time's
   * up. Polling resumes the sandbox, which is what keeps the job RUNNING — a
   * paused sandbox freezes it (and the late-release in LazySandbox pauses it
   * again a couple of minutes after the polling stops).
   */
  function watchManaged(id: string): void {
    const proc = processes.get(id);
    if (!(wake && proc) || proc.watching || proc.collected) {
      return;
    }
    const depth = Number(wake.message.id.match(WAKE_ID)?.[1] ?? 0);
    if (depth >= MAX_WAKE_CHAIN) {
      return;
    }
    proc.watching = true;
    const context = getSandboxContext();
    watch({ context, depth, id, proc, wake })
      .catch((error: unknown) => {
        logger.warn(
          { err: errorMessage(error), id, threadId: wake.thread.id },
          '[background] watcher failed'
        );
      })
      .finally(() => {
        proc.watching = false;
      });
  }

  async function watch({
    context,
    depth,
    id,
    proc,
    wake,
  }: {
    context: SandboxContext;
    depth: number;
    id: string;
    proc: BackgroundProcess;
    wake: ProcessWake;
  }): Promise<void> {
    const { getTurn, USER_ACCOUNT_TURN_SUFFIX } = await import(
      '@/lib/agent/turns'
    );
    const slot = wake.asUserAccount
      ? `${wake.thread.id}${USER_ACCOUNT_TURN_SUFFIX}`
      : wake.thread.id;
    // While the turn that started it runs, it checks the job itself — and two
    // commands at once on one sandbox session are not safe (readManaged).
    const launchingTurn = getTurn({ threadId: slot });
    let deadline: number | undefined;
    while (true) {
      await Bun.sleep(WATCH_POLL_MS);
      if (processes.get(id) !== proc || proc.collected) {
        return;
      }
      if (launchingTurn && getTurn({ threadId: slot }) === launchingTurn) {
        continue;
      }
      deadline ??= Date.now() + WATCH_AFTER_TURN_MS;
      const result = await readManaged(id, context);
      if (!result) {
        return;
      }
      if (!result.finished && Date.now() < deadline) {
        continue;
      }
      // A turn running now (someone asked, or another wake) goes first; it may
      // read the job itself, which makes this wake redundant.
      const quietBy = Date.now() + WAKE_QUIET_MAX_MS;
      while (getTurn({ threadId: slot }) && Date.now() < quietBy) {
        await Bun.sleep(WATCH_POLL_MS);
      }
      if (proc.collected || getTurn({ threadId: slot })) {
        return;
      }
      if (result.finished) {
        proc.collected = true;
      }
      const { runTurn } = await import('@/lib/agent');
      logger.info(
        { finished: result.finished, id, threadId: wake.thread.id },
        '[background] waking the thread about a background job'
      );
      await runTurn({
        asUserAccount: wake.asUserAccount,
        message: processReport({ depth, id, proc, result, wake }),
        thread: wake.thread,
      });
      return;
    }
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
        const proc = processes.get(id);
        if (proc) {
          proc.collected = true;
        }
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
      'Start a shell command running in the background in the sandbox and return immediately with a handle id, instead of waiting for it to finish. Use process (action output) to check on it and process (action kill) to stop it.',
    inputSchema: z.object({
      command: z.string().min(1),
    }),
    execute: async ({ command }) => {
      // This is a SHELL, so it gets the same GitHub ownership gate as bash, gh
      // and codeMode — gating three of four shells is theatre, and this was the
      // ungated one: `runBackgroundProcess("gh pr create …")` walked straight
      // past the repo-ownership check that the identical `bash` command hits.
      const guard = await guardBackgroundGithub({ command, github });
      if (guard) {
        return { error: guard, success: false };
      }
      try {
        const started = await startManaged(command);
        if ('error' in started) {
          return { error: started.error, success: false };
        }
        watchManaged(started.id);
        return {
          id: started.id,
          success: true,
          summary: `Started background process ${started.id}. If your turn ends before it does, you'll be woken with its result when it finishes (or told after 30 minutes if it's still going).`,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const getProcessOutput = tool({
    description:
      'Read the output so far of a background process (started with process (action start), or a bash command that was auto-moved to the background after running over a minute), and whether it is still running. Reports the exit code once finished.',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        const result = await readManaged(id);
        if (!result) {
          return { error: `Unknown process id: ${id}`, success: false };
        }
        await disarmIfFinished(id, result);
        const proc = processes.get(id);
        if (proc && result.finished) {
          proc.collected = true;
        }
        // Still running when checked (often right after a "time's up" wake):
        // keep watching it for another 30 minutes past this turn.
        if (!result.finished) {
          watchManaged(id);
        }
        const context = getSandboxContext();
        return {
          exitCode: result.exitCode,
          id,
          running: !result.finished,
          stderr: await clipManaged(result.stderr, context, 'stderr'),
          stdout: await clipManaged(result.stdout, context, 'stdout'),
          success: true,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  const killProcess = tool({
    description:
      'Kill a background process (started with process (action start) or auto-moved from bash).',
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
    watchManaged,
  };
}

export type BackgroundProcessTools = ReturnType<typeof backgroundProcessTools>;

/**
 * The synthetic message a background job's wake runs on. Authored by whoever
 * started the job, so the turn is gated exactly as their own message would be.
 */
function processReport({
  depth,
  id,
  proc,
  result,
  wake,
}: {
  depth: number;
  id: string;
  proc: BackgroundProcess;
  result: ManagedResult;
  wake: ProcessWake;
}): Message {
  const command =
    proc.command.length > 200 ? `${proc.command.slice(0, 200)}…` : proc.command;
  const tail = (text: string) =>
    text.length > OUTPUT_TAIL_CHARS
      ? `…${text.slice(-OUTPUT_TAIL_CHARS)}`
      : text;
  const output = `stdout (end):\n\`\`\`\n${tail(result.stdout) || '(empty)'}\n\`\`\`\nstderr (end):\n\`\`\`\n${tail(result.stderr) || '(empty)'}\n\`\`\`\nFull output files in the sandbox: ${proc.outPath} and ${proc.errPath}.`;
  const body = result.finished
    ? `the background command ${id} you started earlier in this thread (\`${command}\`) has FINISHED with exit code ${result.exitCode ?? 'unknown'}.\n\n${output}\n\nCarry on with the task it was part of if there is more to do, or tell the thread what matters from it.`
    : `the background command ${id} you started earlier in this thread (\`${command}\`) is STILL RUNNING 30 minutes after your turn ended — time's up for keeping the sandbox awake for it. Once the sandbox pauses it freezes, and it resumes the next time this thread uses the sandbox.\n\n${output}\n\nDecide: if it is worth waiting for, check it with the \`process\` tool (action \`output\`, id "${id}"), which keeps watching it for another 30 minutes; if it is stuck or no longer needed, kill it (action \`kill\`). Say briefly where it stands.`;
  return {
    attachments: [],
    author: wake.message.author,
    id: `process-report-${depth + 1}-${id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: `[Automatic note, not written by a person: ${body} Don't explain that you were woken up. If nothing needs saying, call the skip TOOL — do not write the word "skip" as your reply.]`,
    threadId: wake.thread.id,
  };
}
