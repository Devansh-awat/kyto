import { CommandExitError, Sandbox } from '@e2b/code-interpreter';
import type { Logger } from '@repo/logging/logger';
import { sandboxConfig as config } from './config';
import { DISPLAY_INSTALL_COMMAND } from './display';
import { GIT_HARDEN_COMMAND } from './git-safety';

// NO GitHub credential of any kind is placed in, or brokered into, a sandbox.
//
// Until 2026-08-06 the real PAT was injected by an E2B egress rule that rewrote
// `Authorization` on every github.com request. The token was genuinely
// unextractable, but that missed the point: EVERY process in the box was
// authenticated as `kyto-agent` — a shell script, a background job, sshx, tmate
// — while the guard only ever saw strings that had passed through a kyto tool.
// The credential now lives host-side in `lib/github-proxy`, which `gh` and
// `git` are pointed at (see `githubProxyEnv` / `githubProxyGitConfig`), and it
// classifies and guards each request itself. Do NOT reintroduce a `network`
// rule carrying the token.

// There is no terminal in the sandbox, so a git command that decides it needs
// credentials has nobody to ask. Without these it still TRIES, and the failure
// comes back as `could not read Username for 'https://github.com': No such
// device or address` — which reads like a broken environment and sent a whole
// turn down the wrong path (it was actually a revoked token being rejected by
// GitHub). Turning prompting off makes git fail immediately with the real
// authentication error instead.
//
// Set on `this.env`, which run() merges into EVERY command, so a sandbox
// resumed from before this existed picks it up too — unlike create-time envs.
const GIT_NON_INTERACTIVE: Record<string, string> = {
  GIT_ASKPASS: '/bin/echo',
  GIT_TERMINAL_PROMPT: '0',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingSandboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('not found') ||
    message.includes('404') ||
    message.includes('does not exist')
  );
}

function commandTimeoutMs(): number {
  return Math.max(config.timeoutMs, config.executionTimeoutMs + 60_000);
}

/**
 * Where a thread's sandbox id is remembered between turns. Injected by the
 * caller so this package stays free of a database dependency.
 */
export interface SandboxStore {
  clear(threadId: string): Promise<void>;
  /** The sandbox id last used by this thread, if any. */
  load(threadId: string): Promise<string | null>;
  save(threadId: string, sandboxId: string): Promise<void>;
}

/**
 * A lazy E2B sandbox: `Sandbox.create` happens on the first operation that
 * needs it, so a chat-only turn costs zero E2B.
 *
 * Lifetime depends on `store`. Without one the sandbox is ephemeral — killed at
 * `destroy()`, nothing carries over. With one it is PERSISTENT PER THREAD: the
 * sandbox id is remembered, `destroy()` pauses instead of killing, and the next
 * turn in that thread reconnects to the same filesystem (`Sandbox.connect`
 * auto-resumes a paused sandbox). A paused sandbox costs storage, not compute.
 *
 * The create-time `envs` are fixed at CREATE time and therefore stale on a
 * resumed sandbox. Per-command env is re-sent on every `run()`, so short-lived
 * secrets (the per-turn Slack and GitHub proxy tokens) are always current.
 */
export class LazySandbox {
  readonly workDir = config.workdir;

  private readonly apiKey: string;
  private readonly bootstrapCommand: string | undefined;
  private readonly env: Record<string, string>;
  private readonly logger: Logger;
  private readonly sessionId: string | undefined;
  private readonly store: SandboxStore | undefined;
  private sandbox: Sandbox | null = null;
  private creating: Promise<Sandbox> | null = null;

  constructor({
    apiKey,
    bootstrapCommand,
    env = {},
    logger,
    sessionId,
    store,
  }: {
    apiKey: string;
    /**
     * Shell run once each time the sandbox materializes, before any tool touches
     * it (on a fresh create AND on a resume, so it must be idempotent). For
     * installing helper executables that every later command can rely on.
     */
    bootstrapCommand?: string;
    env?: Record<string, string>;
    logger: Logger;
    sessionId?: string;
    /** Provide to make this thread's sandbox persist across turns. */
    store?: SandboxStore;
  }) {
    this.apiKey = apiKey;
    this.bootstrapCommand = bootstrapCommand;
    this.env = { ...GIT_NON_INTERACTIVE, ...env };
    this.logger = logger;
    this.sessionId = sessionId;
    this.store = store;
  }

  get materialized(): boolean {
    return this.sandbox !== null;
  }

  /** True when this sandbox is remembered across turns for its thread. */
  private get persistent(): boolean {
    return Boolean(this.store && this.sessionId);
  }

  /**
   * Reconnect to the thread's remembered sandbox. Returns null when there is
   * nothing to reconnect to, or when the remembered sandbox is gone (expired,
   * killed out of band) — in which case the stale id is forgotten so the caller
   * falls through to creating a fresh one.
   */
  private async reconnect(): Promise<Sandbox | null> {
    if (!(this.store && this.sessionId)) {
      return null;
    }
    const sandboxId = await this.store.load(this.sessionId).catch(() => null);
    if (!sandboxId) {
      return null;
    }
    try {
      // Auto-resumes the sandbox when it is paused.
      const sandbox = await Sandbox.connect(sandboxId, { apiKey: this.apiKey });
      await sandbox.setTimeout(commandTimeoutMs());
      return sandbox;
    } catch (error) {
      this.logger.info(
        { err: errorText(error), sandboxId },
        '[sandbox] remembered sandbox is gone; creating a fresh one'
      );
      await this.store.clear(this.sessionId).catch(() => undefined);
      return null;
    }
  }

  private async create(): Promise<Sandbox> {
    const sandbox = await Sandbox.create(config.template, {
      apiKey: this.apiKey,
      envs: this.env,
      metadata: {
        app: 'kyto',
        ...(this.sessionId ? { threadId: this.sessionId } : {}),
      },
      timeoutMs: config.timeoutMs,
    });
    await sandbox.files.makeDir(config.workdir).catch(() => undefined);
    if (this.store && this.sessionId) {
      await this.store
        .save(this.sessionId, sandbox.sandboxId)
        .catch((error: unknown) => {
          // A sandbox we can't remember is still a usable sandbox for this
          // turn; it just won't be found again next turn.
          this.logger.warn(
            { err: errorText(error), sandboxId: sandbox.sandboxId },
            '[sandbox] failed to remember sandbox for thread'
          );
        });
    }
    return sandbox;
  }

  /**
   * Install helpers into a freshly materialized sandbox. Best effort: a failed
   * bootstrap must not fail the tool call that triggered materialization — the
   * helper it installs is simply absent, which the caller's command will report.
   */
  private async bootstrap(sandbox: Sandbox): Promise<void> {
    // Git hardening first, and unconditionally: a repo that arrives as a
    // tarball/zip brings its own hooks, and this makes sure none of them can
    // run before any tool touches the workspace. Idempotent, so re-running it
    // on a resumed sandbox is free.
    await sandbox.commands
      .run(GIT_HARDEN_COMMAND, { cwd: this.workDir, timeoutMs: 15_000 })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: errorText(error), sandboxId: sandbox.sandboxId },
          '[sandbox] git hardening failed'
        );
      });
    // Install the shared-display helper. Writing a file, not starting a server:
    // a chat-only turn pays nothing, and the first thing that needs a headful
    // browser gets one display that every later caller reuses (see display.ts).
    await sandbox.commands
      .run(DISPLAY_INSTALL_COMMAND, { cwd: this.workDir, timeoutMs: 15_000 })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: errorText(error), sandboxId: sandbox.sandboxId },
          '[sandbox] display helper install failed'
        );
      });
    if (!this.bootstrapCommand) {
      return;
    }
    // Uses commands.run directly, NOT this.run — the latter calls ensure() and
    // would recurse back into materialization.
    await sandbox.commands
      .run(this.bootstrapCommand, { cwd: this.workDir, timeoutMs: 30_000 })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: errorText(error), sandboxId: sandbox.sandboxId },
          '[sandbox] bootstrap command failed'
        );
      });
  }

  private ensure(): Promise<Sandbox> {
    if (this.sandbox) {
      return Promise.resolve(this.sandbox);
    }
    this.creating ??= (async () => {
      const started = Date.now();
      const resumed = await this.reconnect();
      const sandbox = resumed ?? (await this.create());
      await this.bootstrap(sandbox);
      this.sandbox = sandbox;
      this.logger.info(
        {
          ms: Date.now() - started,
          resumed: Boolean(resumed),
          sandboxId: sandbox.sandboxId,
        },
        '[sandbox] materialized'
      );
      return sandbox;
    })().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  async run({
    abortSignal,
    command,
    env,
    workingDirectory,
  }: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    abortSignal?.throwIfAborted();
    const sandbox = await this.ensure();
    await sandbox.setTimeout(commandTimeoutMs());
    try {
      const result = await sandbox.commands.run(command, {
        cwd: workingDirectory ?? this.workDir,
        envs: { ...this.env, ...env },
        signal: abortSignal,
        timeoutMs: config.executionTimeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stderr: error.stderr,
          stdout: error.stdout,
        };
      }
      throw error;
    }
  }

  async readBinaryFile({ path }: { path: string }): Promise<Uint8Array | null> {
    const sandbox = await this.ensure();
    return await sandbox.files
      .read(path, { format: 'bytes' })
      .catch((error: unknown) => {
        if (isMissingSandboxError(error)) {
          return null;
        }
        throw error;
      });
  }

  async readTextFile({ path }: { path: string }): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path });
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async writeBinaryFile({
    content,
    path,
  }: {
    content: Uint8Array;
    path: string;
  }): Promise<void> {
    const sandbox = await this.ensure();
    // Copy to a standalone ArrayBuffer (a Uint8Array view may be offset).
    await sandbox.files.write(path, content.slice().buffer as ArrayBuffer);
  }

  async writeTextFile({
    content,
    path,
  }: {
    content: string;
    path: string;
  }): Promise<void> {
    await this.writeBinaryFile({
      content: new TextEncoder().encode(content),
      path,
    });
  }

  /**
   * Releases the sandbox iff it was materialized; a chat-only turn is a no-op.
   * A persistent sandbox is PAUSED (its filesystem survives for the thread's
   * next turn); an ephemeral one is killed outright. A pause that fails falls
   * back to a kill, so a sandbox is never left running and billing.
   */
  async destroy(): Promise<void> {
    const pending = this.creating;
    if (pending) {
      await pending.catch(() => undefined);
    }
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (!sandbox) {
      return;
    }
    if (this.persistent) {
      // `pause()` resolves false when it was ALREADY paused — still persisted,
      // still resumable. Only a thrown error means we failed to snapshot it.
      const failure = await sandbox
        .pause()
        .then(() => undefined)
        .catch((error: unknown) => error);
      if (!failure) {
        return;
      }
      this.logger.warn(
        { err: errorText(failure), sandboxId: sandbox.sandboxId },
        '[sandbox] pause failed; killing instead'
      );
      // Couldn't snapshot it, so the id we remembered is about to be useless.
      if (this.sessionId) {
        await this.store?.clear(this.sessionId).catch(() => undefined);
      }
    }
    await sandbox.kill().catch((error: unknown) => {
      this.logger.warn(
        { err: errorText(error), sandboxId: sandbox.sandboxId },
        '[sandbox] kill failed'
      );
    });
  }
}
