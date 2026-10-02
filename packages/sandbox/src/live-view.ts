/**
 * A watch-only live view of the sandbox's shared display (owner's ask,
 * 2026-09-29, after coolton's agent-browser stream). The stealth browser already
 * runs HEADFUL on that display (see display.ts), so streaming the display over
 * VNC shows the browser as it works — no computer-use tooling needed.
 *
 * VIEW-ONLY ON THE SERVER (`x11vnc -viewonly`). The link, password included, is
 * posted into the thread; noVNC's `view_only=true` is only a client default
 * anyone could drop, so without the server flag the link would hand every
 * reader keyboard and mouse control of a browser that may be logged in.
 *
 * Idempotent: a second call reuses the running server and its password, since a
 * new password would not match the one x11vnc already holds.
 */

export const LIVE_VIEW_PORT = 6080;
const VNC_PORT = 5900;
const PASSWORD_FILE = '/home/user/.kyto/live-view-password';
// The noVNC web client, from its release rather than Debian's `novnc` package:
// that one depends on the distro nodejs, which the template purges (taking
// noVNC with it) and which a runtime `apt-get install novnc` would drag back in
// over the real Node.
const NOVNC_DIR = '/opt/novnc';
export const NOVNC_URL =
  'https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz';

/**
 * Starts a stream of one display if needed and prints its password on the last
 * line. Parameterized because the owner's Slack browser streams its OWN display
 * (lib/ai/tools/slack-browser) — a public link to the shared one must never show
 * kyto's Slack — so each stream is told apart by its VNC port, never killed by
 * program name alone.
 */
export function liveViewCommand({
  displayCommand,
  passwordFile,
  vncPort,
  webPort,
}: {
  /** Shell that prints the display to stream, starting it if needed. */
  displayCommand: string;
  passwordFile: string;
  vncPort: number;
  webPort: number;
}): string {
  return `set -e
DISP="$(${displayCommand})"
if ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1; then
  sudo apt-get install -y --no-install-recommends x11vnc websockify >/tmp/live-view-install.log 2>&1 \\
    || { sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y --no-install-recommends x11vnc websockify >/tmp/live-view-install.log 2>&1; }
fi
if [ ! -f ${NOVNC_DIR}/vnc.html ]; then
  sudo mkdir -p ${NOVNC_DIR}
  curl -sfL ${NOVNC_URL} | sudo tar xz -C ${NOVNC_DIR} --strip-components=1
fi
mkdir -p "$(dirname ${passwordFile})" /home/user/.vnc
# Never \`pgrep -f\` here: this script's own text names both programs, so it
# matches the shell running it and the start is silently skipped.
port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
# This stream's x11vnc: view-only and on this port.
own_vnc() {
  for pid in $(pgrep -x x11vnc); do
    tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q -- ' -rfbport ${vncPort} ' && echo "$pid"
  done
}
viewonly_up() {
  for pid in $(own_vnc); do
    tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q -- ' -viewonly' && return 0
  done
  return 1
}
if ! viewonly_up || ! port_up ${vncPort} || [ ! -s ${passwordFile} ]; then
  for pid in $(own_vnc); do kill "$pid" 2>/dev/null || true; done
  # VNC auth only reads 8 characters.
  PASS="$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8)"
  x11vnc -storepasswd "$PASS" ${passwordFile}.vnc >/dev/null 2>&1
  printf '%s' "$PASS" > ${passwordFile}
  chmod 600 ${passwordFile} ${passwordFile}.vnc
  x11vnc -bg -display "$DISP" -forever -shared -viewonly -rfbport ${vncPort} -localhost -rfbauth ${passwordFile}.vnc -o /tmp/x11vnc-${vncPort}.log >/dev/null 2>&1
fi
if ! port_up ${webPort}; then
  setsid nohup websockify --web ${NOVNC_DIR} ${webPort} localhost:${vncPort} </dev/null >/tmp/live-view-${webPort}.log 2>&1 &
  i=0
  until port_up ${webPort}; do
    i=$((i + 1)); [ $i -gt 50 ] && { echo "live view did not start" >&2; tail -n 5 /tmp/live-view-${webPort}.log >&2; exit 1; }
    sleep 0.2
  done
fi
cat ${passwordFile}`;
}

/** The shared display's stream (the plain `browser` tool's). */
export const LIVE_VIEW_COMMAND = liveViewCommand({
  displayCommand: 'kyto-display',
  passwordFile: PASSWORD_FILE,
  vncPort: VNC_PORT,
  webPort: LIVE_VIEW_PORT,
});

/** The shareable URL for a host from `getHost(LIVE_VIEW_PORT)`. */
export function liveViewUrl({
  host,
  password,
}: {
  host: string;
  password: string;
}): string {
  const params = new URLSearchParams({
    autoconnect: 'true',
    password,
    resize: 'scale',
    view_only: 'true',
  });
  return `https://${host}/vnc.html?${params.toString()}`;
}
