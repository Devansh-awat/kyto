import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';

// gh/git are pre-authenticated inside the sandbox WITHOUT the token ever being
// there: LazySandbox brokers the real GITHUB token via E2B egress rules (the
// proxy rewrites the Authorization header on outbound GitHub requests), and the
// sandbox env only holds an inert placeholder. Because the secret is not in the
// sandbox at all, a full shell (piping, jq, etc.) is safe here — `echo $GH_TOKEN`
// only ever reveals the placeholder, so the char-at-a-time drip attack is moot.
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function ghTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      "Run a `gh` (GitHub CLI) command in the sandbox. gh and git are already authenticated (credentials are brokered at the network layer — never ask for a token). It's a real shell, so piping/filtering works, e.g. `gh pr list --repo owner/repo | grep foo` or `gh api repos/o/r/issues --jq '.[].title'`. For external contributions, fork first and push branches to the fork, then open a PR.",
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe('Shell command using gh and/or pipes to other commands.'),
    }),
    execute: async ({ command }, { abortSignal }) => {
      if (!env.GH_TOKEN) {
        return {
          error: 'gh requires GH_TOKEN to be configured on the host.',
          success: false,
        };
      }
      try {
        const context = getSandboxContext();
        const result = await context.session.run({
          abortSignal,
          command,
          workingDirectory: context.sessionWorkDir,
        });
        return {
          exitCode: result.exitCode,
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
