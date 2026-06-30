import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { errorMessage } from '@/lib/utils/error';

// Browser automation runs the preinstalled `agent-browser` CLI inside the
// sandbox (Chromium + untrusted page automation stay isolated off the host).
// agent-browser is stateful: sequential calls in one turn share the same
// browser session (the sandbox lives for the turn). The CLI serves its own,
// always-current usage docs — run `skills get core` first to learn commands.
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function browseTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      'Automate a web browser via the sandbox\'s agent-browser CLI: navigate pages, fill forms, click, screenshot, scrape, or test web apps. Pass the agent-browser sub-command and args in `command` (it is run as `agent-browser <command>`). Run `command: "skills get core"` first to load the current workflows and command reference, then issue navigate/snapshot/click/etc. Sequential calls share one browser session.',
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments passed to the agent-browser CLI, e.g. "skills get core", "navigate https://example.com", or "snapshot".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      const context = getSandboxContext();
      if (!context) {
        return {
          success: false,
          error: 'No active sandbox session is available for browsing.',
        };
      }
      try {
        // Forward the turn's abort signal so a browser command that never
        // returns (a page that hangs loading) is killed when the turn is
        // interrupted or the per-attempt watchdog fires — otherwise Pi stays
        // blocked awaiting this tool and the whole turn freezes.
        const result = await context.session.run({
          abortSignal,
          command: `agent-browser ${command}`,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
          summary:
            result.exitCode === 0
              ? `Ran agent-browser ${command}.`
              : `agent-browser ${command} exited ${result.exitCode}.`,
        };
      } catch (error) {
        return {
          success: false,
          error: errorMessage(error),
          summary: `Browser command failed: ${errorMessage(error)}`,
        };
      }
    },
  });
}
