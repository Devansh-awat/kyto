import type { SandboxContext } from '@repo/ai';

// The browser tool drives the `agent-browser` CLI, but not against the plain
// Chrome-for-Testing build it installs by default: it points it, over CDP, at
// CloakBrowser — a Chromium whose fingerprint is patched at the C++ level, so
// bot-detection (Cloudflare Turnstile, FingerprintJS, reCAPTCHA scoring) treats
// it as an ordinary browser. Fewer pages hand us a challenge in the first place.
//
// The stealth binary (~200MB) is fetched on first use and cached under $HOME, so
// in a thread's persistent sandbox this cost is paid once. The Chromium PROCESS
// does not survive a sandbox pause, so every browser command re-runs this script
// — it exits immediately when the CDP endpoint is already answering.
const CDP_PORT = 9222;

const ENSURE_SCRIPT = `
set -u
CDP=${CDP_PORT}
alive() { curl -sf -m 2 "http://127.0.0.1:$CDP/json/version" >/dev/null 2>&1; }

if alive; then
  echo "cloakbrowser: already running"
  exit 0
fi

if ! command -v cloakbrowser >/dev/null 2>&1; then
  sudo npm install -g cloakbrowser >/tmp/cloak-install.log 2>&1 \
    || npm install -g cloakbrowser >>/tmp/cloak-install.log 2>&1
fi
# 'cloakbrowser install' downloads the binary if needed and prints its path.
BIN="$(cloakbrowser install 2>/dev/null | tail -n1)"
if [ ! -x "$BIN" ]; then
  echo "cloakbrowser: could not install the stealth chromium binary"
  tail -n 20 /tmp/cloak-install.log 2>/dev/null
  exit 1
fi

# Some sites detect headless even through the C++ patches, so prefer a real
# display via Xvfb and only fall back to headless when it cannot be installed.
if ! command -v xvfb-run >/dev/null 2>&1; then
  sudo apt-get install -y -qq xvfb >/dev/null 2>&1 || true
fi

SEED=$(( ($$ % 90000) + 10000 ))
ARGS="--remote-debugging-port=$CDP --no-sandbox --fingerprint=$SEED --fingerprint-platform=windows --user-data-dir=$HOME/.cloakbrowser-profile"
if command -v xvfb-run >/dev/null 2>&1; then
  nohup xvfb-run -a "$BIN" $ARGS >/tmp/cloak.log 2>&1 &
else
  nohup "$BIN" $ARGS --headless=new >/tmp/cloak.log 2>&1 &
fi

i=0
while [ $i -lt 60 ]; do
  alive && break
  i=$((i + 1))
  sleep 0.5
done
if ! alive; then
  echo "cloakbrowser: chromium did not come up"
  tail -n 20 /tmp/cloak.log 2>/dev/null
  exit 1
fi

# Point agent-browser at the stealth Chromium instead of its own Chrome.
agent-browser connect $CDP >/dev/null 2>&1 || true
echo "cloakbrowser: ready"
`;

export type EnsureResult = { ok: true } | { ok: false; error: string };

/**
 * Make sure a CloakBrowser Chromium is running in the sandbox and that
 * agent-browser is attached to it. Cheap (a curl) once it is up.
 */
export async function ensureCloakBrowser({
  abortSignal,
  context,
}: {
  abortSignal?: AbortSignal;
  context: SandboxContext;
}): Promise<EnsureResult> {
  const result = await context.session.run({
    abortSignal,
    command: ENSURE_SCRIPT,
    workingDirectory: context.sessionWorkDir,
  });
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return {
    error:
      `Could not start the stealth browser: ${result.stdout.trim() || result.stderr.trim()}`.trim(),
    ok: false,
  };
}
