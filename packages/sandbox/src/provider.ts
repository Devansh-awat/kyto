import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import { Sandbox } from '@e2b/code-interpreter';
import type { Logger } from '@repo/logging/logger';
import { sandboxConfig } from './config';
import { LazyE2BNetworkSandboxSession } from './lazy-session';

export interface E2BSandboxProviderOptions {
  apiKey: string;
  env?: Record<string, string>;
  logger: Logger;
  template?: string;
}

export class E2BSandboxProvider implements HarnessV1SandboxProvider {
  readonly providerId = 'e2b';
  readonly specificationVersion = 'harness-sandbox-v1';

  private readonly apiKey: string;
  private readonly env: Record<string, string>;
  private readonly template: string;
  private readonly logger: Logger;

  constructor(options: E2BSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.env = options.env ?? {};
    this.template = options.template ?? sandboxConfig.template;
    this.logger = options.logger;
  }

  private readonly spawnSandbox = async ({
    sessionId,
  }: {
    sessionId?: string;
  }): Promise<Sandbox> => {
    const sandbox = await Sandbox.create(this.template, {
      apiKey: this.apiKey,
      envs: this.env,
      lifecycle: { onTimeout: 'pause' },
      timeoutMs: sandboxConfig.timeoutMs,
      metadata: {
        app: 'kyto',
        ...(sessionId ? { threadId: sessionId } : {}),
      },
    });
    await sandbox.files.makeDir(sandboxConfig.workdir);
    return sandbox;
  };

  // Ephemeral + lazy: we never persist or resume a session (the Slack thread is
  // the only source of memory). Hand the harness a lazy session that defers the
  // real E2B `Sandbox.create` until a tool actually needs it, so chat-only turns
  // cost zero sandbox. The session is destroyed at turn end (no DB, no pausing).
  createSession = ({
    sessionId,
  }: {
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: unknown;
    sessionId?: string;
  } = {}) =>
    Promise.resolve(
      new LazyE2BNetworkSandboxSession({
        env: this.env,
        logger: this.logger,
        sessionId,
        spawn: () => this.spawnSandbox({ sessionId }),
      })
    );
}
