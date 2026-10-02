import type { SandboxContext } from '@repo/ai';
import { liveViewCommand, liveViewUrl } from '@repo/sandbox';
import { tool } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import type { ThreadHandle } from '@/harness';
import logger from '@/lib/logger';
import {
  registerSlackWebToken,
  revokeSlackWebToken,
  SLACK_WEB_PREFIX,
  SLACK_WEB_TOKEN_HEADER,
} from '@/lib/slack-web-proxy';
import { errorMessage, toLogError } from '@/lib/utils/error';

// The owner's logged-in Slack browser (owner's ask, 2026-10-02): workflows,
// other apps' buttons, anything the Web API tools can't reach — as kyto's USER
// account. Neither half of that session is ever in the sandbox: a second
// Chromium, on its OWN display, goes through mitmproxy, which hands every
// `*.slack.com` request to the host (lib/slack-web-proxy). The host adds the
// cookie and swaps the token; it refuses only signing out. Everything else the
// box does is untouched — mitmproxy tunnels other hosts unopened.
//
// Its own display, so the plain browser's view never shows it; its own view
// link is posted in the thread too (owner's call).

const MAX_OUTPUT_CHARS = 8000;
const STATE_DIR = '/home/user/.kyto/slack-web';
const CDP_PORT = 9223;
const MITM_PORT = 8899;
const DISPLAY_NUMBER = 77;
const VNC_PORT = 5977;
const WEB_PORT = 6077;
const SESSION = 'kyto-slack';
const COMMAND_TIMEOUT_SECONDS = 90;
// `timeout`'s exit status when it had to stop the command.
const TIMED_OUT_EXIT = 124;

const ADDON = `import os
from mitmproxy import http

BASE_HOST = os.environ["KYTO_SLACK_WEB_HOST"]
TOKEN_FILE = "${STATE_DIR}/token"


def _token():
    try:
        with open(TOKEN_FILE) as handle:
            return handle.read().strip()
    except OSError:
        return ""


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if not (host == "slack.com" or host.endswith(".slack.com")):
        return
    path = flow.request.path
    flow.request.scheme = "https"
    flow.request.host = BASE_HOST
    flow.request.port = 443
    flow.request.path = "${SLACK_WEB_PREFIX}" + host + path
    flow.request.headers["Host"] = BASE_HOST
    flow.request.headers["${SLACK_WEB_TOKEN_HEADER}"] = _token()
`;

const SPKI = `import base64, hashlib, sys
from cryptography import x509
from cryptography.hazmat.primitives import serialization as s
cert = x509.load_pem_x509_certificate(open(sys.argv[1], "rb").read())
der = cert.public_key().public_bytes(s.Encoding.DER, s.PublicFormat.SubjectPublicKeyInfo)
print(base64.b64encode(hashlib.sha256(der).digest()).decode())
`;

// Expects KYTO_SLACK_WEB_HOST and KYTO_SLACK_WEB_TOKEN in the environment.
const ENSURE_SCRIPT = `set -u
SW=${STATE_DIR}
mkdir -p $SW && chmod 700 $SW
printf '%s' "$KYTO_SLACK_WEB_TOKEN" > $SW/token && chmod 600 $SW/token
port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_for() { i=0; until "$@"; do i=$((i + 1)); [ $i -gt 60 ] && return 1; sleep 0.5; done; }

if ! command -v mitmdump >/dev/null 2>&1; then
  python3 -m pip install --quiet --break-system-packages mitmproxy >/tmp/mitm-install.log 2>&1 \\
    || sudo python3 -m pip install --quiet --break-system-packages mitmproxy >>/tmp/mitm-install.log 2>&1
fi
if ! command -v mitmdump >/dev/null 2>&1; then
  echo "slack browser: could not install mitmproxy"; tail -n 20 /tmp/mitm-install.log; exit 1
fi
cat > $SW/addon.py <<'KYTO_ADDON'
${ADDON}KYTO_ADDON
if ! port_up ${MITM_PORT}; then
  # lazy: never open a connection to the real slack.com from the box — the
  # addon re-aims every Slack request at the host before anything connects.
  KYTO_SLACK_WEB_HOST="$KYTO_SLACK_WEB_HOST" setsid nohup mitmdump -q \\
    --listen-host 127.0.0.1 --listen-port ${MITM_PORT} \\
    --set confdir=$SW/mitm --set connection_strategy=lazy \\
    --allow-hosts '(^|\\.)slack\\.com(:[0-9]+)?$' \\
    -s $SW/addon.py </dev/null >/tmp/slack-mitm.log 2>&1 &
  if ! wait_for port_up ${MITM_PORT}; then
    echo "slack browser: the interceptor did not start"; tail -n 20 /tmp/slack-mitm.log; exit 1
  fi
fi
CA=$SW/mitm/mitmproxy-ca-cert.pem
wait_for test -s $CA || { echo "slack browser: no interceptor certificate"; exit 1; }
# mitmproxy signs every site with its CA's own key, so trusting that one key
# trusts the interceptor and nothing else (not a blanket certificate bypass).
SPKI="$(python3 - "$CA" <<'KYTO_SPKI'
${SPKI}KYTO_SPKI
)"

if [ ! -S /tmp/.X11-unix/X${DISPLAY_NUMBER} ]; then
  rm -f /tmp/.X${DISPLAY_NUMBER}-lock 2>/dev/null || sudo rm -f /tmp/.X${DISPLAY_NUMBER}-lock
  setsid nohup Xvfb :${DISPLAY_NUMBER} -screen 0 1600x1000x24 -nolisten tcp </dev/null >/tmp/slack-display.log 2>&1 &
  wait_for test -S /tmp/.X11-unix/X${DISPLAY_NUMBER} || { echo "slack browser: display did not start"; exit 1; }
fi

alive() { curl -sf -m 2 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; }
if ! alive; then
  if ! command -v cloakbrowser >/dev/null 2>&1; then
    sudo npm install -g cloakbrowser >/tmp/cloak-install.log 2>&1 \\
      || npm install -g cloakbrowser >>/tmp/cloak-install.log 2>&1
  fi
  BIN="$(cloakbrowser install 2>/dev/null | tail -n1)"
  [ -x "$BIN" ] || { echo "slack browser: could not install chromium"; exit 1; }
  mkdir -p $SW/home
  # Its own HOME too, so nothing it writes lands beside the plain browser's.
  HOME=$SW/home DISPLAY=:${DISPLAY_NUMBER} setsid nohup "$BIN" \\
    --remote-debugging-port=${CDP_PORT} --no-sandbox --test-type --no-first-run \\
    --user-data-dir=$SW/profile \\
    --proxy-server=http://127.0.0.1:${MITM_PORT} \\
    --ignore-certificate-errors-spki-list="$SPKI" \\
    --window-position=0,0 --window-size=1600,1000 \\
    https://app.slack.com/client </dev/null >/tmp/slack-chrome.log 2>&1 &
  if ! wait_for alive; then
    echo "slack browser: chromium did not come up"; tail -n 20 /tmp/slack-chrome.log; exit 1
  fi
fi
echo "slack browser: ready"
`;

// Kills by a marker read from /proc rather than pgrep -f, which would match
// this script's own text. The markers are split ("92""23") for the same reason.
const CLEANUP_SCRIPT = `set +e
agent-browser --session ${SESSION} close >/dev/null 2>&1
kill_matching() {
  for dir in /proc/[0-9]*; do
    pid=\${dir#/proc/}
    [ "$pid" = "$$" ] && continue
    { tr '\\0' ' ' < "$dir/cmdline"; } 2>/dev/null | grep -q -- "$1" && kill "$pid" 2>/dev/null
  done
}
kill_matching "remote-debugging-port=$(printf '%s' 92 23)"
kill_matching "listen-port $(printf '%s' 88 99)"
kill_matching "rfbport $(printf '%s' 59 77) "
kill_matching " $(printf '%s' 60 77) localhost"
kill_matching "Xvfb :$(printf '%s' 7 7) "
rm -rf ${STATE_DIR}
echo done
`;

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)`
    : text;
}

/** The link goes to the owner alone: this display shows kyto's whole Slack. */
async function sendLiveView({
  abortSignal,
  asUserAccount,
  context,
  thread,
}: {
  abortSignal?: AbortSignal;
  asUserAccount: boolean;
  context: SandboxContext;
  thread: ThreadHandle;
}): Promise<boolean> {
  try {
    const started = await context.session.run({
      abortSignal,
      command: liveViewCommand({
        displayCommand: `echo :${DISPLAY_NUMBER}`,
        passwordFile: `${STATE_DIR}/live-view-password`,
        vncPort: VNC_PORT,
        webPort: WEB_PORT,
      }),
    });
    const password = started.stdout.trim().split('\n').at(-1) ?? '';
    if (started.exitCode !== 0 || !password) {
      logger.warn(
        { exitCode: started.exitCode, stderr: started.stderr.slice(-500) },
        '[slack-browser] live view did not start'
      );
      return false;
    }
    const url = liveViewUrl({
      host: await context.session.getHost(WEB_PORT),
      password,
    });
    // In the thread, like the plain browser's (owner's call, 2026-10-02) —
    // anyone there can watch kyto's Slack, DMs included, while it runs.
    const markdown = `_watching kyto's Slack browser live: [open the view](${url}) (watch-only, ends when this reply does)_`;
    await thread.post({ markdown }).catch(async (error: unknown) => {
      // The user account can be in a channel the app is not.
      if (!asUserAccount) {
        throw error;
      }
      await thread.post({ fromUserAccount: true, markdown });
    });
    return true;
  } catch (error) {
    logger.warn(toLogError(error), '[slack-browser] live view failed');
    return false;
  }
}

export function slackBrowserTool({
  asUserAccount,
  getSandboxContext,
  thread,
}: {
  /** Answering as kyto's user account (the live-view post's fallback sender). */
  asUserAccount: boolean;
  getSandboxContext: () => SandboxContext | undefined;
  thread: ThreadHandle;
}) {
  let secret: string | undefined;
  let liveView: Promise<boolean> | undefined;
  let usedContext: SandboxContext | undefined;

  const slackBrowser = tool({
    description: `Drive a real browser LOGGED IN to Slack as kyto's own user account (owner only) — for what the Slack tools can't do: running workflows, clicking buttons on other apps' messages or App Homes, forms, settings pages. Same agent-browser CLI as the \`browser\` tool (pass its sub-command in \`command\`; run "skills get core" first if you need the reference), but a separate browser that starts on https://app.slack.com/client. Nothing is blocked except signing out (owner only, owner's call): it can send, edit, react, join, upload and run workflows AS kyto's user account, so act only on what the owner asked. A live view is posted in the thread.`,
    inputSchema: z.object({
      command: z
        .string()
        .min(1)
        .describe(
          'Arguments for agent-browser, e.g. "snapshot", "open https://app.slack.com/client/T0266FRGM/C0B7QEK0MQB", "click @e12".'
        ),
    }),
    execute: async ({ command }, { abortSignal }) => {
      const context = getSandboxContext();
      if (!context) {
        return {
          error: 'No active sandbox session is available for browsing.',
          success: false,
        };
      }
      try {
        secret ??= registerSlackWebToken();
        usedContext = context;
        const ready = await context.session.run({
          abortSignal,
          command: ENSURE_SCRIPT,
          env: {
            KYTO_SLACK_WEB_HOST: env.SITES_PUBLIC_HOST,
            KYTO_SLACK_WEB_TOKEN: secret,
          },
        });
        if (ready.exitCode !== 0) {
          const error = `Could not start the Slack browser: ${(ready.stdout.trim() || ready.stderr.trim()).slice(-1500)}`;
          return { error, success: false, summary: error };
        }
        liveView ??= sendLiveView({
          abortSignal,
          asUserAccount,
          context,
          thread,
        });
        const result = await context.session.run({
          abortSignal,
          // Bounded: a click on a half-loaded Slack page once hung for minutes
          // and left the daemon "busy" for the next command, freezing the turn.
          command: `timeout ${COMMAND_TIMEOUT_SECONDS} agent-browser --session ${SESSION} --cdp ${CDP_PORT} ${command}`,
          workingDirectory: context.sessionWorkDir,
        });
        const viewSent = await liveView;
        let summary = `Slack browser ${command} exited ${result.exitCode}.`;
        if (result.exitCode === 0) {
          summary = `Ran Slack browser ${command}.`;
        } else if (result.exitCode === TIMED_OUT_EXIT) {
          summary = `Slack browser ${command} took over ${COMMAND_TIMEOUT_SECONDS}s and was stopped; take a snapshot to see where the page is.`;
        }
        return {
          exitCode: result.exitCode,
          ...(viewSent
            ? {
                liveView:
                  'A watch-only live view link is already posted in the thread; no need to share it again.',
              }
            : {}),
          stderr: truncate(result.stderr),
          stdout: truncate(result.stdout),
          success: result.exitCode === 0,
          summary,
        };
      } catch (error) {
        return {
          error: errorMessage(error),
          success: false,
          summary: `Slack browser command failed: ${errorMessage(error)}`,
        };
      }
    },
  });

  return {
    /**
     * End of turn: revoke the host token FIRST (from then on the box holds
     * nothing that reaches Slack), then tear the browser, its profile — the web
     * client caches messages in IndexedDB — and the stream down, so a later
     * turn in this thread, maybe someone else's, finds none of it.
     */
    close: async (): Promise<void> => {
      revokeSlackWebToken(secret);
      if (!usedContext) {
        return;
      }
      await Promise.resolve(
        usedContext.session.run({ command: CLEANUP_SCRIPT })
      ).catch((error: unknown) =>
        logger.warn(toLogError(error), '[slack-browser] cleanup failed')
      );
    },
    tool: slackBrowser,
  };
}
