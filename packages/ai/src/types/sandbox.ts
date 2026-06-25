export interface SandboxContext {
  session: {
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
    }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
  };
  sessionWorkDir: string;
}
