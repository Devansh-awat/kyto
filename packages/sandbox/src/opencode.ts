// OpenCode (opencode.ai), the coding agent kyto hands code work to (owner's
// call, 2026-09-29). It runs in the thread's sandbox on OpenCode's own free
// models, so the building and running is not done on Hack Club AI's key.
//
// Those free models' providers may train on what they are sent, and Hack Club's
// policy forbids training on Slack messages without every author's consent — so
// OpenCode must never reach Slack. Three layers, weakest last:
//
// 1. The `opencode` on PATH is a WRAPPER that drops the read-only Slack proxy's
//    credentials before exec'ing the real binary. Without them the in-sandbox
//    `slack` helper cannot reach Slack at all. This is the one that matters, and
//    it applies whether OpenCode is started by the `opencode` tool or by a plain
//    `bash` call.
// 2. Its global config denies `slack` commands and disables session sharing
//    (a shared session is a public URL of everything it was told).
// 3. Its global AGENTS.md tells it so.
//
// kyto's brief is also written without Slack content (the prompt says so), which
// is what keeps other people's messages out of it in the first place.
//
// Idempotent and cheap once installed (a few file writes), so the tool runs it
// before every call: a sandbox resumed from before this existed, or one whose
// template predates it, heals itself.

export const OPENCODE_PREFIX = '/home/user/.kyto/opencode';

const WRAPPER = `#!/usr/bin/env bash
# kyto: OpenCode never gets Slack (see packages/sandbox/src/opencode.ts).
unset KYTO_SLACK_PROXY KYTO_SLACK_PROXY_TOKEN
exec "${OPENCODE_PREFIX}/bin/opencode" "$@"
`;

const CONFIG = JSON.stringify(
  {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    permission: {
      // Last match wins, so the denies come after the catch-all allow. `run` is
      // non-interactive: an `ask` would simply hang.
      bash: {
        '*': 'allow',
        '*_slackapi*': 'deny',
        '*slack *': 'deny',
        slack: 'deny',
        'slack *': 'deny',
      },
    },
    share: 'disabled',
  },
  null,
  2
);

const RULES = `# Rules for this environment

- You have NO access to Slack and must never try to get it: do not run the
  \`slack\` command, do not call any Slack API, do not look for Slack tokens.
- Work only on the task you were given and the files in this sandbox.
- When you finish, say briefly what you built or changed, where the files are,
  and how to run it.
`;

function heredoc(path: string, body: string, tag: string): string {
  return `cat > ${path} <<'${tag}'\n${body}\n${tag}`;
}

/** Install OpenCode if missing, and (re)write its wrapper, config and rules. */
export const OPENCODE_SETUP_COMMAND = [
  'set -e',
  `if [ ! -x ${OPENCODE_PREFIX}/bin/opencode ]; then npm install -g --prefix ${OPENCODE_PREFIX} opencode-ai >/dev/null 2>&1; fi`,
  'WRAPPER_TMP=$(mktemp)',
  heredoc('"$WRAPPER_TMP"', WRAPPER.trimEnd(), 'KYTO_OPENCODE_WRAPPER'),
  'chmod +x "$WRAPPER_TMP"',
  'if [ -w /usr/local/bin ]; then mv "$WRAPPER_TMP" /usr/local/bin/opencode; else sudo mv "$WRAPPER_TMP" /usr/local/bin/opencode; fi',
  'mkdir -p "$HOME/.config/opencode"',
  heredoc(
    '"$HOME/.config/opencode/opencode.json"',
    CONFIG,
    'KYTO_OPENCODE_CONFIG'
  ),
  heredoc(
    '"$HOME/.config/opencode/AGENTS.md"',
    RULES.trimEnd(),
    'KYTO_OPENCODE_RULES'
  ),
].join('\n');
