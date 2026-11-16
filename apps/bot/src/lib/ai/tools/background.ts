import type { SandboxContext } from '@repo/ai';
import { mayHaveFetchedRepo } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import type { ThreadHandle } from '@/harness/thread';
import type { Message } from '@/harness/types';
import { parseGithubCommand } from '@/lib/github/command';
import { guardGithubCommand } from '@/lib/github/guard';
import logger from '@/lib/logger';
import { disarmFetchedRepos, fetchStart } from '@/lib/sandbox/git-safety';
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
  /** Set while the command may have fetched a repo whose hooks aren't stripped yet. */
  fetchCommand?: string;
  /** Sandbox epoch seconds taken before the command started. */
  fetchSince?: number;
  /** Its turn was interrupted while waiting on it; the next turn is told. */
  orphaned?: boolean;
  outPath: string;
  pid: string;
  /** A host-side watcher is polling it (see startWatching). */
  watching?: boolean;
}

// Per THREAD, not per turn: a job outlives the turn that started it, and the
// next turn (a wake, or someone asking "is it done?") got "Unknown process id"
// for a job that was still running. In memory: a restart loses them, as it
// loses the sandbox's own process.
interface ThreadProcesses {
  /**
   * The sandbox of the turn that registered it, so a stop can reach the jobs.
   * The VALUE, never the turn's `getSandboxContext` closure: a closure keeps
   * its whole defining scope alive in Bun, and these maps outlive the turn, so
   * every thread ever woken kept its last turn's toolset (~20-30k Functions)
   * until a restart. Found hunting the 2026-11-16 growth (RSS 166 MB -> 1.5 GB
   * in 30 h).
   */
  context: SandboxContext;
  processes: Map<string, BackgroundProcess>;
}
// Turns that wake the thread share ONE registry (`threadProcesses`). A secret or
// unattended turn gets its own, so its handles never show up in another turn's
// process list; `stopRegistries` lists both so an explicit STOP reaches every
// job anyway.
const threadProcesses = new Map<string, ThreadProcesses>();
const stopRegistries = new Map<string, Set<ThreadProcesses>>();
// One counter for the process, not per registry: a thread's registry is
// dropped once empty, and a fresh one counting from 1 again would hand a new
// job an id (`bg-1`) the model saw for an earlier, killed one.
let jobCounter = 0;

/**
 * Drop a registry from both maps once it holds no handle: nothing left for a
 * STOP to kill or for the next turn to read. Called whenever a handle goes; a
 * turn still running keeps its own reference and re-lists it on its next job.
 */
function forgetIfEmpty(registry: ThreadProcesses, stopKey?: string): void {
  if (registry.processes.size > 0 || !stopKey) {
    return;
  }
  if (threadProcesses.get(stopKey) === registry) {
    threadProcesses.delete(stopKey);
  }
  const set = stopRegistries.get(stopKey);
  set?.delete(registry);
  if (set?.size === 0) {
    stopRegistries.delete(stopKey);
  }
}

/** Registry sizes, for tests. */
export function backgroundRegistrySizes(): {
  stopRegistries: number;
  threadProcesses: number;
} {
  return {
    stopRegistries: stopRegistries.size,
    threadProcesses: threadProcesses.size,
  };
}

/** Whether a STOP in this thread has background jobs to kill. */
export function hasThreadProcesses(threadId: string): boolean {
  for (const registry of stopRegistries.get(threadId) ?? []) {
    if (registry.processes.size > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Kill every background job of a thread (an explicit STOP): their whole
 * process groups, then forget the handles so no watcher wakes the thread about
 * them later. Hooks are stripped from anything a killed job had fetched, as for
 * a job that finished. Returns how many were killed.
 */
export async function killThreadProcesses(threadId: string): Promise<number> {
  const registries = stopRegistries.get(threadId);
  stopRegistries.delete(threadId);
  let killed = 0;
  for (const registry of registries ?? []) {
    const procs = [...registry.processes.values()];
    registry.processes.clear();
    // Its stop entry is gone above. The thread entry goes too: a turn still
    // running keeps its own reference and re-lists it on its next job.
    if (threadProcesses.get(threadId) === registry) {
      threadProcesses.delete(threadId);
    }
    if (procs.length === 0) {
      continue;
    }
    const context = registry.context;
    const pids = procs.map((proc) => proc.pid).join(' ');
    await context.session.run({
      command: `for p in ${pids}; do kill -9 -$p 2>/dev/null || kill -9 $p 2>/dev/null; done; true`,
    });
    for (const proc of procs) {
      if (proc.fetchCommand) {
        await disarmFetchedRepos({
          command: proc.fetchCommand,
          context,
          since: proc.fetchSince ?? 0,
        });
      }
    }
    killed += procs.length;
  }
  return killed;
}

/**
 * Commands an interrupted turn was still waiting on, once each. The command
 * keeps running in the sandbox (it is detached; only the WAIT was cut), but the
 * next turn didn't know: it re-ran a finished `git clone` into the folder that
 * clone had made, and spent calls recovering (#166).
 */
export function takeOrphanedCommands(
  threadId: string
): { command: string; id: string }[] {
  const orphans: { command: string; id: string }[] = [];
  for (const [id, proc] of threadProcesses.get(threadId)?.processes ?? []) {
    if (proc.orphaned && !proc.collected) {
      proc.orphaned = false;
      orphans.push({ command: proc.command, id });
    }
  }
  return orphans;
}

// How long a job may keep the sandbox awake after its turn ended, before kyto
// is told time's up (owner's call 2026-10-08: 30 min, then kyto decides).
const WATCH_AFTER_TURN_MS = 30 * 60 * 1000;
const WATCH_POLL_MS = 20 * 1000;
// A wake turn that starts or re-checks a job may be woken again, but not
// forever: a model re-arming every half hour would run all day.
const MAX_WAKE_CHAIN = 3;
export const WAKE_ID = /^process-report-(\d+)-/;
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
   * exempt — see the guard call in `runBackgroundProcess`.
   */
  github?: { isOwner: boolean; threadId: string; userId: string };
}) {
  const key = wake?.thread.id;
  const stopKey = key ?? github?.threadId;
  // A registry is listed in the maps only while it holds a job, so a turn that
  // starts none — nearly all of them — leaves nothing behind, and neither does
  // a build that throws before it is closed. The thread's LISTED one is looked
  // up on every use, not once here: the app and the account kyto can run in
  // one thread at once (separate turn slots) and must see each other's jobs.
  let own: ThreadProcesses | undefined;
  const sandboxContext = getSandboxContext();
  function current(): ThreadProcesses {
    const listed = key ? threadProcesses.get(key) : undefined;
    if (listed) {
      listed.context = sandboxContext;
      return listed;
    }
    own ??= { context: sandboxContext, processes: new Map() };
    return own;
  }

  /** List the registry so a STOP, a wake and the next turn can find its jobs. */
  function list(registry: ThreadProcesses): void {
    if (!stopKey) {
      return;
    }
    if (key && !threadProcesses.has(key)) {
      threadProcesses.set(key, registry);
    }
    const set = stopRegistries.get(stopKey) ?? new Set<ThreadProcesses>();
    set.add(registry);
    stopRegistries.set(stopKey, set);
  }

  /** A job's handle, wherever this thread's jobs are listed now. */
  function find(id: string): BackgroundProcess | undefined {
    return current().processes.get(id);
  }

  /** Forget a handle, and the registry with it once nothing is left. */
  function remove(id: string): void {
    const registry = current();
    registry.processes.delete(id);
    forgetIfEmpty(registry, stopKey);
  }

  async function startManaged(
    command: string,
    workingDirectory?: string
  ): Promise<{ id: string } | { error: string }> {
    const context = getSandboxContext();
    const since = await fetchStart({ command, context });
    jobCounter += 1;
    const id = `bg-${jobCounter}`;
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
    // The script goes in a FILE, not the argv: `pkill -f <pattern>` in the
    // command used to match this wrapper's own command line, kill it before it
    // wrote the exit file, and leave the call "unfinished" until its timeout.
    const scriptPath = `${base}.sh`;
    const wrapped = `{ ${command}\n} >"${proc.outPath}" 2>"${proc.errPath}" </dev/null; echo $? >"${proc.exitPath}"`;
    await context.session.writeBinaryFile({
      content: new TextEncoder().encode(wrapped),
      path: scriptPath,
    });
    // `setsid`: its own process group, whose id is this pid, so a kill takes
    // the command's children too. A plain `&` shares the shell's group, and
    // the group kill silently missed: only `sh` died, the command ran on.
    const launch = `nohup setsid sh ${shSingleQuote(scriptPath)} >/dev/null 2>&1 </dev/null & echo $!`;
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
    const registry = current();
    registry.processes.set(id, proc);
    list(registry);
    if (mayHaveFetchedRepo(command)) {
      // A detached command finishes out of band, so the disarm happens when a
      // poll first sees it done (or it is killed) rather than at start time.
      proc.fetchCommand = command;
      proc.fetchSince = since;
    }
    return { id };
  }

  /** Strip hooks from anything a finished background command fetched. */
  async function disarmIfFinished(
    id: string,
    result: ManagedResult
  ): Promise<string | undefined> {
    const proc = find(id);
    const command = proc?.fetchCommand;
    if (!(proc && command && result.finished)) {
      return;
    }
    proc.fetchCommand = undefined;
    return await disarmFetchedRepos({
      command,
      context: getSandboxContext(),
      since: proc.fetchSince ?? 0,
    });
  }

  async function readManaged(
    id: string,
    context: SandboxContext = getSandboxContext(),
    /**
     * A poll: the output comes back only once the job has finished. Polling
     * used to copy the WHOLE output files every time (base64 through the
     * heap), so a job with a growing log re-allocated several times its size
     * on every poll: every 250-2000 ms in waitManaged, every 20 s while
     * watched. Still one command, so a finished job costs no extra round trip.
     */
    { whileRunning = 'output' }: { whileRunning?: 'output' | 'status' } = {}
  ): Promise<ManagedResult | null> {
    const proc = find(id);
    if (!proc) {
      return null;
    }
    // Do this in ONE sandbox command. `commands.run()` calls against one E2B
    // session are not a safe concurrent transport: the old Promise.all could
    // return one stream from a different poll while another was still being
    // copied, which surfaced as mysteriously missing stdout. The completion
    // marker is written after both streams, so it is read FIRST: read last, a
    // command finishing between the reads came back "finished" with the
    // output it had before it printed (an `echo` read as empty).
    const streams = `for path in "${proc.outPath}" "${proc.errPath}"; do base64 -w0 "$path" 2>/dev/null || true; printf '\n'; done`;
    const exit = `exit64=$(base64 -w0 "${proc.exitPath}" 2>/dev/null || true); printf '%s\n' "$exit64"`;
    const snapshot = await context.session.run({
      command:
        whileRunning === 'status'
          ? `${exit}; if [ -n "$exit64" ]; then ${streams}; fi`
          : `${exit}; ${streams}`,
    });
    const [exit64 = '', stdout64 = '', stderr64 = ''] =
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
    const proc = find(id);
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
      if (find(id) !== proc || proc.collected) {
        return;
      }
      if (launchingTurn && getTurn({ threadId: slot }) === launchingTurn) {
        continue;
      }
      deadline ??= Date.now() + WATCH_AFTER_TURN_MS;
      const status = await readManaged(id, context, { whileRunning: 'status' });
      if (!status) {
        return;
      }
      if (!status.finished && Date.now() < deadline) {
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
      // Read again for the report. Up to 15 min may have passed (a finished
      // job's output is final, but a running one's has grown), and a job
      // still running at the deadline came back without output.
      const result = await readManaged(id, context);
      if (!result) {
        return;
      }
      if (result.finished) {
        proc.collected = true;
      }
      const { runTurn } = await import('@/lib/agent');
      logger.info(
        {
          command: proc.command.slice(0, 200),
          finished: result.finished,
          id,
          stderrChars: result.stderr.length,
          stdoutChars: result.stdout.length,
          threadId: wake.thread.id,
        },
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
    let result: ManagedResult | null = null;
    while (Date.now() < deadline) {
      abortSignal?.throwIfAborted();
      // A finished job's poll carries its full output (the exit marker is
      // written after both streams, so it is complete).
      result = await readManaged(id, undefined, { whileRunning: 'status' });
      if (!result || result.finished) {
        break;
      }
      const wait = POLL_STEPS_MS[Math.min(step, POLL_STEPS_MS.length - 1)];
      step += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    // Still running at the deadline: one read of what it printed so far, for
    // the caller to show, kill it, or hand out a handle.
    if (!result?.finished) {
      result = await readManaged(id);
    }
    if (!result) {
      return { finished: false, stderr: '', stdout: '' };
    }
    if (result.finished) {
      // The id was never shown to the model (only a backgrounded command's
      // is), so nothing can name it again: drop the handle, or the thread's
      // registry — which outlives the turn — keeps it (and a STOP later
      // "kills" its long-dead pid) forever.
      remove(id);
    }
    return result;
  }

  // Kill the whole process group the launcher started, so children of the
  // command die too, then forget the handle.
  async function killManaged(id: string): Promise<boolean> {
    const proc = find(id);
    if (!proc) {
      return false;
    }
    await getSandboxContext().session.run({
      command: `kill -9 -${proc.pid} 2>/dev/null || kill -9 ${proc.pid} 2>/dev/null || true`,
    });
    remove(id);
    if (proc.fetchCommand) {
      await disarmFetchedRepos({
        command: proc.fetchCommand,
        context: getSandboxContext(),
        since: proc.fetchSince ?? 0,
      });
    }
    return true;
  }

  const runBackgroundProcess = tool({
    description:
      "Start a shell command running in the background in the sandbox and return immediately with a handle id, instead of waiting for it to finish: for a dev server, a watcher, a long build or benchmark you work alongside. Not for something you'd only wait on straight away (that is plain bash). Use getProcessOutput to check on it and killProcess to stop it.",
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
          summary: `Started background process ${started.id}. Check it with getProcessOutput (id ${started.id}); stop it with killProcess (id ${started.id}). If your turn ends before it does, you'll be woken with its result when it finishes (or told after 30 minutes if it's still going), so don't poll it just to wait.`,
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
        const securityNotice = await disarmIfFinished(id, result);
        const proc = find(id);
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
          securityNotice,
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
      'Kill a background process (started with runBackgroundProcess or auto-moved from bash).',
    inputSchema: z.object({
      id: z.string().min(1),
    }),
    execute: async ({ id }) => {
      try {
        if (!(await killManaged(id))) {
          return { error: `Unknown process id: ${id}`, success: false };
        }
        return { success: true, summary: `Killed process ${id}.` };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });

  function orphanManaged(id: string): void {
    const proc = find(id);
    if (proc) {
      proc.orphaned = true;
    }
  }

  return {
    getProcessOutput,
    killManaged,
    orphanManaged,
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
  const silent = !(result.stdout.trim() || result.stderr.trim());
  const body = result.finished
    ? `the background command ${id} you started earlier in this thread (\`${command}\`) has FINISHED with exit code ${result.exitCode ?? 'unknown'}.\n\n${output}${silent ? '\n\nIt printed NOTHING. Exit 0 with no output is not proof it worked (a run that refused every write exited 0 like this): check the files it was meant to produce before you say it did.' : ''}\n\nCarry on with the task it was part of if there is more to do, or tell the thread what matters from it.`
    : `the background command ${id} you started earlier in this thread (\`${command}\`) is STILL RUNNING 30 minutes after your turn ended: time's up for keeping the sandbox awake for it. Once the sandbox pauses it freezes, and it resumes the next time this thread uses the sandbox.\n\n${output}\n\nDecide: if it is worth waiting for, check it with getProcessOutput (id "${id}"), which keeps watching it for another 30 minutes; if it is stuck or no longer needed, kill it (killProcess). Only post if the thread is waiting on its result or it failed in a way someone needs to know; killing a leftover job nobody asked about is housekeeping, so do it and call skip (an unasked "stopped the leftover job" message was noise, issue #71).`;
  return {
    attachments: [],
    author: wake.message.author,
    id: `process-report-${depth + 1}-${id}-${Date.now()}`,
    isMention: false,
    metadata: { dateSent: new Date() },
    raw: {},
    text: `[Automatic note, not written by a person: ${body} Don't explain that you were woken up. If nothing needs saying, call the skip TOOL. Do not write the word "skip" as your reply.]`,
    threadId: wake.thread.id,
  };
}
