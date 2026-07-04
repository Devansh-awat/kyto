import { runOnce } from '@repo/sandbox';
import { env } from '@/env';

const MAX_OUTPUT_CHARS = 4000;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`
    : text;
}

/**
 * Runs a shell command in a brand-new, throwaway sandbox and returns its exact
 * output. Unlike the harness's lazy per-turn sandbox, recurring 'bash'
 * reminders fire on their own schedule outside any turn, so this spins up and
 * kills a real sandbox every run rather than reusing session machinery.
 */
export async function runReminderBash(command: string): Promise<string> {
  const result = await runOnce(command, env.E2B_API_KEY);
  const parts = [
    truncate(result.stdout.trim()),
    result.stderr.trim() ? `stderr:\n${truncate(result.stderr.trim())}` : '',
  ].filter(Boolean);
  const output = parts.join('\n\n') || '(no output)';
  return result.exitCode === 0
    ? output
    : `${output}\n\n(exit code ${result.exitCode})`;
}
