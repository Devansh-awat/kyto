import nodePath from 'node:path/posix';
import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { clamp } from '@/lib/utils/text';

// The model's workspace tools (replacing Pi's builtin bash/file tools). Every
// tool runs in the lazy E2B sandbox: the first call materializes it, chat-only
// turns never create one.

const OUTPUT_MAX = 12_000;

function resolvePath(context: SandboxContext, path: string): string {
  return nodePath.normalize(
    path.startsWith('/') ? path : nodePath.join(context.sessionWorkDir, path)
  );
}

function clip(text: string): string {
  return clamp(text, OUTPUT_MAX) ?? text;
}

export function bashTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Run a bash command in your isolated Linux sandbox (network access, common CLIs, bun/node/python preinstalled). The workspace is ephemeral — it starts empty each turn and is destroyed at turn end.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run.'),
      workingDirectory: z
        .string()
        .optional()
        .describe('Working directory (defaults to the workspace).'),
    }),
    execute: async ({ command, workingDirectory }, { abortSignal }) => {
      const context = getSandboxContext();
      const result = await context.session.run({
        abortSignal,
        command,
        workingDirectory: workingDirectory
          ? resolvePath(context, workingDirectory)
          : undefined,
      });
      return {
        exitCode: result.exitCode,
        stderr: clip(result.stderr),
        stdout: clip(result.stdout),
      };
    },
  });
}

export function readFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Read a text file from the sandbox workspace. Returns null if the file does not exist.',
    inputSchema: z.object({
      endLine: z.number().int().min(1).optional(),
      path: z.string(),
      startLine: z.number().int().min(1).optional(),
    }),
    execute: async ({ endLine, path, startLine }) => {
      const context = getSandboxContext();
      const bytes = await context.session.readBinaryFile({
        path: resolvePath(context, path),
      });
      if (!bytes) {
        return { content: null, found: false };
      }
      let text = new TextDecoder().decode(bytes);
      if (startLine !== undefined || endLine !== undefined) {
        text = text
          .split('\n')
          .slice(Math.max((startLine ?? 1) - 1, 0), endLine)
          .join('\n');
      }
      return { content: clip(text), found: true };
    },
  });
}

export function writeFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Write a text file in the sandbox workspace (creates parent directories, overwrites existing content).',
    inputSchema: z.object({
      content: z.string(),
      path: z.string(),
    }),
    execute: async ({ content, path }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(content),
        path: resolved,
      });
      return { bytes: content.length, path: resolved, written: true };
    },
  });
}

export function editFileTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Edit a text file in the sandbox by exact string replacement. oldString must match the file contents exactly (including whitespace) and, unless replaceAll is true, exactly once.',
    inputSchema: z.object({
      newString: z.string(),
      oldString: z.string(),
      path: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async ({ newString, oldString, path, replaceAll }) => {
      const context = getSandboxContext();
      const resolved = resolvePath(context, path);
      const bytes = await context.session.readBinaryFile({ path: resolved });
      if (!bytes) {
        throw new Error(`File not found: ${resolved}`);
      }
      const text = new TextDecoder().decode(bytes);
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        throw new Error('oldString was not found in the file.');
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `oldString matches ${occurrences} times; make it unique or set replaceAll.`
        );
      }
      const updated = replaceAll
        ? text.replaceAll(oldString, newString)
        : text.replace(oldString, newString);
      await context.session.writeBinaryFile({
        content: new TextEncoder().encode(updated),
        path: resolved,
      });
      return { path: resolved, replaced: occurrences };
    },
  });
}
