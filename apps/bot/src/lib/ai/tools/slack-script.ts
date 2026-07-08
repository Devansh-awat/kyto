import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { readOnlySlackMethods } from '@/lib/slack-proxy';
import { errorMessage } from '@/lib/utils/error';

const MAX_OUTPUT_CHARS = 12_000;

// A shell helper injected before the model's script: `slack <method> [jsonArgs]`
// POSTs to the host-side read-only Slack proxy (secret-gated, token never in the
// sandbox) and prints the JSON response. The model composes loops + jq around it.
const SLACK_HELPER = `slack() {
  local body="\${2:-}"
  [ -z "$body" ] && body='{}'
  curl -sS -X POST "$KYTO_SLACK_PROXY/$1" \\
    -H "Authorization: Bearer $KYTO_SLACK_PROXY_TOKEN" \\
    -H 'Content-Type: application/json' \\
    -d "$body"
}
`;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

export function slackScriptTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description: `Run a bash script in the sandbox that queries Slack READ-ONLY, for aggregate questions that would otherwise need many individual lookups — e.g. "who is in the most channels", "most active user in #x", "how many members does each channel have". A helper \`slack <method> [jsonArgs]\` is preloaded; it prints the raw JSON API response. Compose loops, jq, sort, etc. around it. It is strictly read-only (posting/editing/deleting is impossible through it) and the Slack token never enters the sandbox. Handle pagination via response.response_metadata.next_cursor. Allowed methods: ${readOnlySlackMethods().join(', ')}. Example: \`slack conversations.list '{"limit":1000,"types":"public_channel"}' | jq '.channels | length'\`.`,
    inputSchema: z.object({
      script: z
        .string()
        .min(1)
        .describe(
          'Bash script using the preloaded `slack` helper (plus jq/awk/etc.). Print your final answer to stdout.'
        ),
    }),
    execute: async ({ script }, { abortSignal }) => {
      try {
        const context = getSandboxContext();
        const result = await context.session.run({
          abortSignal,
          command: `${SLACK_HELPER}\n${script}`,
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
