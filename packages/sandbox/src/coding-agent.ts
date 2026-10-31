// The coding agent kyto hands code work to (the `codingAgent` tool; owner's call,
// 2026-09-29, moved from OpenCode to Crush 2026-10-19). It runs in the
// thread's sandbox, OFF Hack Club AI's key, on the owner's router.
//
// Crush (charmbracelet/crush) replaced the OpenCode CLI because of memory: the
// sandbox has 1 GB, OpenCode's Bun process peaked at 465-620 MB on a small run,
// and on 2026-10-18 both of a turn's OpenCode runs were OOM-killed (exit 137).
// Crush is one Go binary: 80 MB peak on the same kind of task.
//
// Its model is reached through kyto's host-side proxy (lib/code-model-proxy):
// the sandbox only ever sees a per-run token in KYTO_CODE_MODEL_URL/TOKEN, and
// the proxy adds the real key and forces the model.
//
// The model's provider may train on what it is sent, and Hack Club's policy
// forbids training on Slack messages without every author's consent — so the
// agent must never reach Slack:
//
// 1. The tool suspends the turn's Slack proxy token host-side for the run.
//    That is the real boundary.
// 2. The `crush` on PATH is a WRAPPER that drops the Slack proxy's credentials
//    before exec'ing the real binary, so even a `crush` started from plain
//    `bash` has no way to Slack.
// 3. Its rules file tells it so.
//
// Idempotent and cheap once installed (a few file writes), so the tool runs it
// before every call: a sandbox from an older template heals itself.

// Pinned like the bot's Bun: a new release is a deliberate update.
const CRUSH_VERSION = '0.98.1';
const CRUSH_PREFIX = '/home/user/.kyto/crush';

const WRAPPER = `#!/usr/bin/env bash
# kyto: the coding agent never gets Slack (see packages/sandbox/src/coding-agent.ts).
unset KYTO_SLACK_PROXY KYTO_SLACK_PROXY_TOKEN
exec "${CRUSH_PREFIX}/crush" "$@"
`;

// crushrc is Bash, run when Crush starts: the model URL and token come from
// the run's environment, never from this file.
const CRUSHRC = `#!/usr/bin/env bash
option default-providers false
option provider-auto-update false
option metrics false
option auto-lsp false
option progress false
option attribution-trailer-style none
option request-timeout 300
option global-context-path /home/user/.config/crush/RULES.md
provider add kyto --type openai-compat --base-url "$KYTO_CODE_MODEL_URL" --api-key "$KYTO_CODE_MODEL_TOKEN"
model add kyto/kyto-code --name "kyto code" --context-window 128000 --default-max-tokens 16000
model large kyto/kyto-code
model small kyto/kyto-code
`;

const RULES = `# Rules for this environment

- You have NO access to Slack and must never try to get it: do not run the
  \`slack\` command, do not call any Slack API, do not look for Slack tokens.
- Work only on the task you were given and the files in this sandbox.
- The machine has only 1 GB of memory, and running out kills you and loses the
  work. Typecheck or test only what you changed (one package, one test file),
  never a whole large repo at once, and never leave a dev server or browser
  running.
- When you finish, say briefly what you built or changed, where the files are,
  and how to run it.
`;

function heredoc(path: string, body: string, tag: string): string {
  return `cat > ${path} <<'${tag}'\n${body}\n${tag}`;
}

/** Install Crush if missing, and (re)write its wrapper, config and rules. */
export const CODING_AGENT_SETUP_COMMAND = [
  'set -e',
  `if [ ! -x ${CRUSH_PREFIX}/crush ]; then`,
  '  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=x86_64 ;; esac',
  `  mkdir -p ${CRUSH_PREFIX}`,
  `  curl -sfL "https://github.com/charmbracelet/crush/releases/download/v${CRUSH_VERSION}/crush_${CRUSH_VERSION}_Linux_$ARCH.tar.gz" | tar xz -C ${CRUSH_PREFIX} --strip-components=1`,
  'fi',
  'WRAPPER_TMP=$(mktemp)',
  heredoc('"$WRAPPER_TMP"', WRAPPER.trimEnd(), 'KYTO_CRUSH_WRAPPER'),
  'chmod +x "$WRAPPER_TMP"',
  'if [ -w /usr/local/bin ]; then mv "$WRAPPER_TMP" /usr/local/bin/crush; else sudo mv "$WRAPPER_TMP" /usr/local/bin/crush; fi',
  'mkdir -p "$HOME/.config/crush"',
  heredoc('"$HOME/.config/crush/crushrc"', CRUSHRC.trimEnd(), 'KYTO_CRUSHRC'),
  heredoc(
    '"$HOME/.config/crush/RULES.md"',
    RULES.trimEnd(),
    'KYTO_CRUSH_RULES'
  ),
].join('\n');

/** For the template build: the same pinned release, pre-installed. */
export const CRUSH_INSTALL_COMMAND = `mkdir -p ${CRUSH_PREFIX} && curl -sfL "https://github.com/charmbracelet/crush/releases/download/v${CRUSH_VERSION}/crush_${CRUSH_VERSION}_Linux_x86_64.tar.gz" | tar xz -C ${CRUSH_PREFIX} --strip-components=1`;
