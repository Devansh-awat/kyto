import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// Both tools shell out via the sandbox's session.run (same pattern as
// browse.ts/deploy-site.ts) rather than a dedicated harness file API, since
// SandboxContext only exposes read/writeBinaryFile + run.
function resolveInWorkspace(sessionWorkDir: string, path: string): string {
  const resolved = nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(sessionWorkDir, path)
  );
  if (
    resolved !== sessionWorkDir &&
    !resolved.startsWith(`${sessionWorkDir}/`)
  ) {
    throw new Error('Path must be inside the sandbox workspace.');
  }
  return resolved;
}

export function deleteFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Delete a file or directory in the sandbox workspace. Set recursive to delete a non-empty directory.',
    inputSchema: z.object({
      path: z.string().min(1),
      recursive: z.boolean().default(false),
    }),
    execute: async ({ path, recursive }) => {
      const context = getSandboxContext();
      if (!context) {
        return {
          success: false,
          error: 'No active sandbox session is available.',
        };
      }
      try {
        const target = resolveInWorkspace(context.sessionWorkDir, path);
        const result = await context.session.run({
          command: `rm ${recursive ? '-rf' : '-f'} -- ${JSON.stringify(target)}`,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          success: result.exitCode === 0,
          summary:
            result.exitCode === 0
              ? `Deleted ${path}.`
              : `Failed to delete ${path}: ${result.stderr.trim()}`,
        };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  });
}

export function fileStatTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Get metadata (size in bytes, kind, last modified time) for a file or directory in the sandbox workspace.',
    inputSchema: z.object({
      path: z.string().min(1),
    }),
    execute: async ({ path }) => {
      const context = getSandboxContext();
      if (!context) {
        return {
          success: false,
          error: 'No active sandbox session is available.',
        };
      }
      try {
        const target = resolveInWorkspace(context.sessionWorkDir, path);
        const result = await context.session.run({
          command: `stat -c '%n|%s|%Y|%F' -- ${JSON.stringify(target)}`,
          workingDirectory: context.sessionWorkDir,
        });
        if (result.exitCode !== 0) {
          return {
            success: false,
            error: result.stderr.trim() || `${path} does not exist.`,
          };
        }
        const [name, size, mtime, kind] = result.stdout.trim().split('|');
        return {
          success: true,
          path: target,
          name: nodePath.basename(name ?? target),
          sizeBytes: Number(size),
          modifiedAt: new Date(Number(mtime) * 1000).toISOString(),
          kind,
        };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    },
  });
}
