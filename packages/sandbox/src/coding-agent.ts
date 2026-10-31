// The coding agent kyto hands code work to (the `codingAgent` tool; owner's call,
// 2026-09-29). It runs in the thread's sandbox, OFF Hack Club AI's key, on the
// owner's router. It is pi (earendil-works/pi-mono) since 2026-10-31.
//
// OpenCode left first because of memory: the sandbox has 1 GB and its Bun
// process was OOM-killed at 465-620 MB. Crush (one Go binary, 80 MB) followed,
// and left because of tokens: its system prompt and 18 tool schemas put 9.6k
// tokens in front of EVERY model call, and the route it ran on allowed ~20k
// tokens a minute, so a run was rate-limited by its third call. pi's prompt and
// four tools (read, bash, edit, write) are ~1.4k tokens; it peaked at ~160 MB.
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
// 2. The `pi` on PATH is a WRAPPER that drops the Slack proxy's credentials
//    before exec'ing the real one, so even a `pi` started from plain `bash`
//    has no way to Slack.
// 3. Its rules file tells it so.
//
// Idempotent and cheap once installed (a few file writes), so the tool runs it
// before every call: a sandbox from an older template heals itself.

// Pinned like the bot's Bun: a new release is a deliberate update. A changed
// version reinstalls, since the marker file holds the installed one.
const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_VERSION = '1.4.0';
const PI_PREFIX = '/home/user/.kyto/pi';
const PI_AGENT_DIR = '/home/user/.pi/agent';
/** The rules file the tool appends to pi's system prompt. */
export const CODING_AGENT_RULES_PATH = `${PI_AGENT_DIR}/kyto-rules.md`;

// --ignore-scripts: pi needs no install scripts, and nothing a dependency's
// postinstall would do belongs in the sandbox.
const PI_INSTALL = `npm install -g --prefix ${PI_PREFIX} --ignore-scripts --no-fund --no-audit ${PI_PACKAGE}@${PI_VERSION} && echo ${PI_VERSION} > ${PI_PREFIX}/.version`;

// PI_OFFLINE stops its model-catalog refresh and update checks; PI_TELEMETRY
// its install telemetry. Neither is wanted from a sandbox.
const WRAPPER = `#!/usr/bin/env bash
# kyto: the coding agent never gets Slack (see packages/sandbox/src/coding-agent.ts).
unset KYTO_SLACK_PROXY KYTO_SLACK_PROXY_TOKEN
export PI_OFFLINE=1 PI_TELEMETRY=0
exec "${PI_PREFIX}/bin/pi" "$@"
`;

// The one model pi knows; the host proxy forces the real one. `baseUrl` is
// written from the run's env at setup (pi does not expand it), the key is
// "$KYTO_CODE_MODEL_TOKEN", which pi reads from the environment at run time,
// so the per-run secret is never written to a file.
const MODELS_JSON = `{
  "providers": {
    "kyto": {
      "baseUrl": "$KYTO_CODE_MODEL_URL",
      "api": "openai-completions",
      "apiKey": "\\$KYTO_CODE_MODEL_TOKEN",
      "models": [
        { "id": "kyto-code", "name": "kyto code", "contextWindow": 128000, "maxTokens": 16000 }
      ]
    }
  }
}`;

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

/** Install pi if missing or outdated, and (re)write its wrapper, model and rules. */
export const CODING_AGENT_SETUP_COMMAND = [
  'set -e',
  `if [ "$(cat ${PI_PREFIX}/.version 2>/dev/null)" != '${PI_VERSION}' ]; then`,
  `  rm -rf ${PI_PREFIX} && mkdir -p ${PI_PREFIX}`,
  `  ${PI_INSTALL}`,
  'fi',
  'WRAPPER_TMP=$(mktemp)',
  heredoc('"$WRAPPER_TMP"', WRAPPER.trimEnd(), 'KYTO_PI_WRAPPER'),
  'chmod +x "$WRAPPER_TMP"',
  'if [ -w /usr/local/bin ]; then mv "$WRAPPER_TMP" /usr/local/bin/pi; else sudo mv "$WRAPPER_TMP" /usr/local/bin/pi; fi',
  `mkdir -p ${PI_AGENT_DIR}`,
  // Unquoted tag: the URL expands now; the escaped token reference doesn't.
  `cat > ${PI_AGENT_DIR}/models.json <<KYTO_PI_MODELS\n${MODELS_JSON}\nKYTO_PI_MODELS`,
  heredoc(CODING_AGENT_RULES_PATH, RULES.trimEnd(), 'KYTO_PI_RULES'),
].join('\n');

/** For the template build: the same pinned release, pre-installed. */
export const CODING_AGENT_INSTALL_COMMAND = `mkdir -p ${PI_PREFIX} && ${PI_INSTALL}`;
