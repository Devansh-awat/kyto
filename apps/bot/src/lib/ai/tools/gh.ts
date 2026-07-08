import type { SandboxContext } from '@repo/ai';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { errorMessage } from '@/lib/utils/error';

// Runs `gh` (GitHub CLI) in the turn's sandbox. The token is the whole security
// concern here, so the design deliberately gives the model NO shell:
//
//  - The model supplies `args` as an ARRAY of arguments to `gh` — not a shell
//    command line. We run `gh` with each arg single-quoted, so there is no
//    command substitution, no piping, no `$GH_TOKEN` expansion, no `echo`/`env`.
//    The model can only ever invoke `gh` itself with literal arguments.
//  - GH_TOKEN is injected into ONLY this one call's process env (never exported
//    into a persistent shell), and `gh auth …` is blocked so the token can't be
//    printed back via `gh auth token` / `gh auth status --show-token`.
//
// This is what defeats the drip-exfiltration attack that a shell-based tool is
// vulnerable to: with a shell you can run `echo ${GH_TOKEN:0:1}` a character at
// a time across many calls and reassemble the token, which per-call substring
// redaction can't stop. With no shell and no `gh auth`, there is no path for the
// model to read the token at all. Output is still scanned and redacted as
// defense-in-depth. To filter/shape output, use gh's own `--json`/`--jq`/
// `--template` flags instead of shell pipes.
const MAX_OUTPUT_CHARS = 8000;
const MIN_REDACT_LEN = 8;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

/** Single-quote an argument so the shell treats it as one inert literal. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}

/** Redact the real token, and any sufficiently long contiguous substring of
 * it, from returned output — defense-in-depth on top of the no-shell design. */
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
  getSandboxContext: () => SandboxContext;
}) {
  return tool({
    description:
      'Run a GitHub CLI (`gh`) command in the sandbox. Pass the arguments to `gh` as an ARRAY, e.g. ["pr","list","--repo","owner/repo"] or ["api","repos/o/r/issues","--jq",".[].title"]. This runs `gh` directly with no shell, so there is no piping — use gh\'s own --json/--jq/--template flags to filter output. `gh auth` is not allowed.',
    inputSchema: z.object({
      args: z
        .array(z.string())
        .min(1)
        .describe(
          'Arguments passed to `gh` (no shell; each is a literal arg).'
        ),
    }),
    execute: async ({ args }, { abortSignal }) => {
      const token = env.GH_TOKEN;
      if (!token) {
        return {
          error: 'gh requires GH_TOKEN to be configured.',
          success: false,
        };
      }
      if (args[0]?.toLowerCase() === 'auth') {
        return {
          error:
            'Blocked: `gh auth` is not allowed (it can print or manage the token).',
          success: false,
        };
      }
      try {
        const context = getSandboxContext();
        const command = `gh ${args.map(shellQuote).join(' ')}`;
        const result = await context.session.run({
          abortSignal,
          command,
          env: { GH_TOKEN: token },
          workingDirectory: context.sessionWorkDir,
        });
        return {
          exitCode: result.exitCode,
          stderr: redactToken(truncate(result.stderr), token),
          stdout: redactToken(truncate(result.stdout), token),
          success: result.exitCode === 0,
        };
      } catch (error) {
        return { error: errorMessage(error), success: false };
      }
    },
  });
}
