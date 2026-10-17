const GH_SUBCOMMAND =
  /^\s*(?:alias|api|attestation|auth|browse|cache|codespace|config|extension|gist|gpg-key|issue|label|org|pr|project|release|repo|ruleset|run|search|secret|ssh-key|status|variable|workflow)\s/;

// Models drop the leading `gh` ("repo create …", "api -X POST …") and the
// shell answered "repo: command not found" — read as a refusal, which sent
// kyto hunting for another route (#80). The same happens after `&&` or `;`
// (`gh api user && api user/repos`, 7s wasted, #102), so every command of the
// line is checked; quoted text (a PR body) is skipped, never rewritten.
export function withGhPrefixes(command: string): string {
  let out = '';
  let quote: string | undefined;
  let commandStart = true;
  let i = 0;
  while (i < command.length) {
    const char = command[i] ?? '';
    if (quote) {
      out += char;
      if (char === '\\' && quote === '"') {
        out += command[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (commandStart && GH_SUBCOMMAND.test(command.slice(i))) {
      out += `${command.slice(i).match(/^\s*/)?.[0] ?? ''}gh `;
      i += command.slice(i).match(/^\s*/)?.[0].length ?? 0;
      commandStart = false;
      continue;
    }
    if (char === '&' && command[i + 1] === '&') {
      out += '&&';
      i += 2;
      commandStart = true;
      continue;
    }
    if (char === ';' || (char === '|' && command[i + 1] === '|')) {
      const op = char === ';' ? ';' : '||';
      out += op;
      i += op.length;
      commandStart = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    }
    if (char.trim()) {
      commandStart = false;
    }
    out += char;
    i += 1;
  }
  return out;
}
