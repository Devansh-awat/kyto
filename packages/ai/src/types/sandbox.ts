export interface SandboxContext {
  session: {
    /** The public hostname that reaches `port` inside the sandbox. */
    getHost(port: number): PromiseLike<string>;
    readBinaryFile(input: { path: string }): PromiseLike<Uint8Array | null>;
    writeBinaryFile(input: {
      content: Uint8Array;
      path: string;
    }): PromiseLike<void>;
    run(input: {
      command: string;
      workingDirectory?: string;
      env?: Record<string, string>;
      abortSignal?: AbortSignal;
      /**
       * Run in the sandbox if `abortSignal` fires, before it is released.
       * Aborting only drops the connection — the command itself keeps going.
       */
      onAbortCommand?: string;
    }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
    /**
     * Release the sandbox. On a persistent (per-thread) sandbox this PAUSES it —
     * the filesystem survives and the next call transparently resumes it — so a
     * long `wait` can suspend it rather than pay for idle compute.
     */
    destroy(): PromiseLike<void>;
  };
  sessionWorkDir: string;
  /**
   * Cut the sandbox off from Slack until the returned function is called. The
   * proxy token is in the environment of every process in the sandbox, so
   * hiding it from one child is not a boundary — this revokes it host-side.
   */
  suspendSlack?: () => () => void;
}
