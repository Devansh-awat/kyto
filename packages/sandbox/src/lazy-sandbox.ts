import { CommandExitError, Sandbox } from '@e2b/code-interpreter';
import type { Logger } from '@repo/logging/logger';
import { sandboxConfig as config } from './config';

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
 * A truly lazy, ephemeral E2B sandbox: `Sandbox.create` happens on the first
 * operation that needs it (a chat-only turn costs zero E2B), and `destroy()`
 * kills it at turn end. Nothing is ever persisted, paused, or resumed — the
 * Slack thread is the only memory. With the custom agent loop there is no
 * framework bootstrap to fake anymore: no tool call, no sandbox.
 */
export class LazySandbox {
  readonly workDir = config.workdir;

  private readonly apiKey: string;
  private readonly env: Record<string, string>;
  private readonly logger: Logger;
  private readonly sessionId: string | undefined;
  private sandbox: Sandbox | null = null;
  private creating: Promise<Sandbox> | null = null;

  constructor({
    apiKey,
    env = {},
    logger,
    sessionId,
  }: {
    apiKey: string;
    env?: Record<string, string>;
    logger: Logger;
    sessionId?: string;
  }) {
    this.apiKey = apiKey;
    this.env = env;
    this.logger = logger;
    this.sessionId = sessionId;
  }

  get materialized(): boolean {
    return this.sandbox !== null;
  }

  private ensure(): Promise<Sandbox> {
    if (this.sandbox) {
      return Promise.resolve(this.sandbox);
    }
    this.creating ??= (async () => {
      const started = Date.now();
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
      this.sandbox = sandbox;
      this.logger.info(
        { ms: Date.now() - started, sandboxId: sandbox.sandboxId },
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

  /** Kills the sandbox iff it was materialized; a chat-only turn is a no-op. */
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
    await sandbox.kill().catch((error: unknown) => {
      this.logger.warn(
        { err: error, sandboxId: sandbox.sandboxId },
        '[sandbox] kill failed'
      );
    });
  }
}
