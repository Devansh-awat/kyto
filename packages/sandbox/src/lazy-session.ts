import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type {
  Experimental_SandboxProcess,
  Experimental_SandboxSession,
} from '@ai-sdk/provider-utils';
import type { Sandbox } from '@e2b/code-interpreter';
import type { Logger } from '@repo/logging/logger';
import { sandboxConfig as config } from './config';
import { E2BNetworkSandboxSession } from './session';

interface RunArgs {
  abortSignal?: AbortSignal;
  command: string;
  env?: Record<string, string>;
  workingDirectory?: string;
}
interface RunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}
interface LazyOptions {
  env?: Record<string, string>;
  logger: Logger;
  sessionId?: string;
  spawn: () => Promise<Sandbox>;
}

const EMPTY_RUN: RunResult = { exitCode: 0, stderr: '', stdout: '' };
const MKDIR_PREFIX = /^mkdir -p (.+)$/;
// The harness/Pi bootstrap mirror listing (Pi's syncHostWorkspaceFromSandbox).
const WORKSPACE_LISTING = /find \. -maxdepth 1[\s\S]*-print0/;
const RESOLVE_HOME = /printf\s+["']?%s["']?\s+["']?\$HOME["']?/;

/**
 * A network sandbox session that defers the real E2B `Sandbox.create` until the
 * first operation that genuinely needs a sandbox. This makes chat-only turns
 * (where Pi answers in-process and never touches the sandbox) cost **zero** E2B.
 *
 * How it stays lazy: the Pi harness unconditionally runs a tiny, fixed set of
 * shell commands on the sandbox at session start — `mkdir -p <sessionWorkDir>`
 * and one workspace-mirror `find` listing (and, only when Pi skills are loaded,
 * a `printf $HOME`; kyto loads **no** Pi skills, so that one is incidental).
 * Because we never persist a session, the workspace is always empty at start, so
 * these bootstrap commands have known, side-effect-free answers we can fabricate
 * without a sandbox. Any *other* `run`, or any file/spawn op, is real work and
 * materializes the sandbox (replaying the recorded `mkdir`s first).
 *
 * WARNING: this couples to the harness/Pi bootstrap command shapes
 * (`@ai-sdk/harness` + `@ai-sdk/harness-pi`). If a version bump changes those
 * commands, faked ones would fall through to materialization — degrading to
 * "sandbox every turn" (correct, just not lazy). Re-check on harness upgrades.
 */
export class LazyE2BNetworkSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly defaultWorkingDirectory = config.workdir;
  readonly ports: readonly number[] = [];
  id: string;

  private real: E2BNetworkSandboxSession | null = null;
  private creating: Promise<E2BNetworkSandboxSession> | null = null;
  private readonly pendingDirs = new Set<string>([config.workdir]);
  private readonly options: LazyOptions;

  constructor(options: LazyOptions) {
    this.options = options;
    this.id = `lazy-${options.sessionId ?? 'session'}-${Date.now()}`;
  }

  get materialized(): boolean {
    return this.real !== null;
  }

  get description(): string {
    return `Lazy E2B sandbox (default working directory: ${config.workdir}).`;
  }

  private async ensure(): Promise<E2BNetworkSandboxSession> {
    if (this.real) {
      return this.real;
    }
    this.creating ??= this.spawnReal();
    const real = await this.creating;
    this.real = real;
    return real;
  }

  private async spawnReal(): Promise<E2BNetworkSandboxSession> {
    const sandbox = await this.options.spawn();
    const real = new E2BNetworkSandboxSession({
      env: this.options.env,
      sandbox,
    });
    // Replay the deferred bootstrap `mkdir`s so the work dir exists.
    for (const dir of this.pendingDirs) {
      await real
        .run({ command: `mkdir -p ${JSON.stringify(dir)}` })
        .catch(() => undefined);
    }
    this.id = real.id;
    this.options.logger.info(
      { sandboxId: real.id, sessionId: this.options.sessionId },
      '[sandbox] materialized lazy e2b sandbox'
    );
    return real;
  }

  /**
   * If the command is one of the known fakeable bootstrap commands AND we have
   * not materialized yet, return a synthetic result; otherwise return null to
   * signal "materialize and run for real".
   */
  private fakeBootstrap(command: string): RunResult | null {
    const trimmed = command.trim();
    const mkdir = MKDIR_PREFIX.exec(trimmed);
    if (mkdir?.[1]) {
      this.pendingDirs.add(mkdir[1].trim());
      return EMPTY_RUN;
    }
    if (WORKSPACE_LISTING.test(trimmed)) {
      // Fresh, never-persisted workspace → the mirror listing is empty.
      return EMPTY_RUN;
    }
    if (RESOLVE_HOME.test(trimmed)) {
      return { exitCode: 0, stderr: '', stdout: config.workdir };
    }
    return null;
  }

  run = async (args: RunArgs): Promise<RunResult> => {
    if (!this.real) {
      const faked = this.fakeBootstrap(args.command);
      if (faked) {
        return faked;
      }
    }
    return (await this.ensure()).run(args);
  };

  readFile = async (args: {
    abortSignal?: AbortSignal;
    path: string;
  }): Promise<ReadableStream<Uint8Array> | null> =>
    (await this.ensure()).readFile(args);

  readBinaryFile = async (args: {
    abortSignal?: AbortSignal;
    path: string;
  }): Promise<Uint8Array | null> => (await this.ensure()).readBinaryFile(args);

  readTextFile = async (args: {
    abortSignal?: AbortSignal;
    encoding?: string;
    endLine?: number;
    path: string;
    startLine?: number;
  }): Promise<string | null> => (await this.ensure()).readTextFile(args);

  writeFile = async (args: {
    abortSignal?: AbortSignal;
    content: ReadableStream<Uint8Array>;
    path: string;
  }): Promise<void> => (await this.ensure()).writeFile(args);

  writeBinaryFile = async (args: {
    abortSignal?: AbortSignal;
    content: Uint8Array;
    path: string;
  }): Promise<void> => (await this.ensure()).writeBinaryFile(args);

  writeTextFile = async (args: {
    abortSignal?: AbortSignal;
    content: string;
    encoding?: string;
    path: string;
  }): Promise<void> => (await this.ensure()).writeTextFile(args);

  spawn = async (args: RunArgs): Promise<Experimental_SandboxProcess> =>
    (await this.ensure()).spawn(args);

  restricted(): Experimental_SandboxSession {
    return {
      description: this.description,
      readFile: this.readFile,
      readBinaryFile: this.readBinaryFile,
      readTextFile: this.readTextFile,
      writeFile: this.writeFile,
      writeBinaryFile: this.writeBinaryFile,
      writeTextFile: this.writeTextFile,
      run: this.run,
      spawn: this.spawn,
    } as Experimental_SandboxSession;
  }

  getPortUrl = async (args: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => (await this.ensure()).getPortUrl(args);

  // Ephemeral lifecycle: never pause (we never resume). Kill if materialized,
  // otherwise nothing was ever created. `stop` and `destroy` are both teardown.
  stop = async (): Promise<void> => {
    await this.real?.destroy().catch(() => undefined);
  };

  destroy = async (): Promise<void> => {
    await this.real?.destroy().catch(() => undefined);
  };
}
