import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';

// Runs `gh` (and arbitrary shell around it, so piping/filtering works) in the
// SAME sandbox the rest of the turn's tools already use — no dedicated
// throwaway sandbox, per the owner's call. GH_TOKEN is injected only into
// THIS ONE `session.run` call's env (not exported into the persistent shell
// session), so no later bash/read call in the turn inherits it as an
// environment variable. Two layers of defense on top of that scoping:
//  1. Block commands that try to manage or print auth/credentials directly
//     (gh auth, env, printenv, /proc/self/environ, etc.) — necessarily
//     incomplete, since shell commands are infinitely obfuscatable.
//  2. Scan the ACTUAL returned stdout/stderr for the real token value (or any
//     long-enough contiguous substring of it) and redact matches — this
//     catches a partial/obfuscated leak regardless of how the command tried
//     to produce it, since it checks the real bytes against the real secret
//     rather than guessing at intent.
// Residual risk the owner accepted by not using a separate sandbox: a command
// could still write the token to a FILE in the shared workspace, which would
// then be readable by other tools later in the SAME turn (the sandbox itself
// is destroyed at turn end, so this can't leak across turns, but it isn't
// contained within one either).
const MAX_OUTPUT_CHARS = 8000;
const MIN_REDACT_LEN = 8;
const BLOCKED_PATTERN =
  /\bgh\s+auth\b|\benv\b|\bprintenv\b|\/proc\/self\/environ|\bset\b\s*$/i;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

/** Redact the real token, and any sufficiently long contiguous substring of
 * it, from returned output — catches partial leaks regardless of technique. */
function redactToken(text: string, token: string): string {
  let redacted = text.split(token).join('[REDACTED]');
  for (let len = token.length; len >= MIN_REDACT_LEN; len--) {
    for (let start = 0; start + len <= token.length; start++) {
      const slice = token.slice(start, start + len);
      if (redacted.includes(slice)) {
        redacted = redacted.split(slice).join('[REDACTED]');
      }
    }
  }
  return redacted;
}

export function ghTool({
  getSandboxContext,
}: {
  getSandboxContext: () => SandboxContext | undefined;
}) {
  return tool({
    description:
      "Run a `gh` (GitHub CLI) command in the sandbox — a real shell, so piping/filtering works (e.g. `gh pr list --repo owner/repo | grep foo`, `gh api repos/o/r/issues --jq '.[].title'`). The token is injected only for this one call and never persists as a sandbox environment variable. Commands that manage or print auth/credentials (gh auth, env, printenv, etc.) are blocked, and any leak of the token itself is redacted from output.",
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Shell command to run, using gh and/or piping to other commands.'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      if (!env.GH_TOKEN) {
        return {
          error: 'gh requires GH_TOKEN to be configured.',
          success: false,
        };
      }
      if (BLOCKED_PATTERN.test(command)) {
        return {
          error:
            'Blocked: commands that manage or print auth/credentials (gh auth, env, printenv, etc.) are not allowed.',
          success: false,
        };
      }
      const context = getSandboxContext();
      if (!context) {
        return {
          error: 'No active sandbox session is available.',
          success: false,
        };
      }
      try {
        const result = await context.session.run({
          abortSignal,
          command,
          env: { GH_TOKEN: env.GH_TOKEN },
          workingDirectory: context.sessionWorkDir,
        });
        const stdout = redactToken(truncate(result.stdout), env.GH_TOKEN);
        const stderr = redactToken(truncate(result.stderr), env.GH_TOKEN);
        return {
          exitCode: result.exitCode,
          stderr,
          stdout,
          success: result.exitCode === 0,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
