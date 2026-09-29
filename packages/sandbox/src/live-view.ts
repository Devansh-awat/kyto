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

/** Starts the stream if needed and prints its password on the last line. */
export const LIVE_VIEW_COMMAND = `set -e
DISP="$(kyto-display)"
if ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1 || [ ! -d /usr/share/novnc ]; then
  sudo apt-get install -y --no-install-recommends x11vnc novnc websockify >/tmp/live-view-install.log 2>&1 \\
    || { sudo apt-get update >/dev/null 2>&1 && sudo apt-get install -y --no-install-recommends x11vnc novnc websockify >/tmp/live-view-install.log 2>&1; }
fi
mkdir -p /home/user/.kyto /home/user/.vnc
# Never \`pgrep -f\` here: this script's own text names both programs, so it
# matches the shell running it and the start is silently skipped.
port_up() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
viewonly_up() {
  for pid in $(pgrep -x x11vnc); do
    tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -q -- ' -viewonly' && return 0
  done
  return 1
}
if ! viewonly_up || ! port_up ${VNC_PORT} || [ ! -s ${PASSWORD_FILE} ]; then
  pkill -x x11vnc 2>/dev/null || true
  # VNC auth only reads 8 characters.
  PASS="$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8)"
  x11vnc -storepasswd "$PASS" /home/user/.vnc/passwd >/dev/null 2>&1
  printf '%s' "$PASS" > ${PASSWORD_FILE}
  chmod 600 ${PASSWORD_FILE}
  x11vnc -bg -display "$DISP" -forever -shared -viewonly -rfbport ${VNC_PORT} -localhost -rfbauth /home/user/.vnc/passwd -o /tmp/x11vnc.log >/dev/null 2>&1
fi
if ! port_up ${LIVE_VIEW_PORT}; then
  setsid nohup websockify --web /usr/share/novnc ${LIVE_VIEW_PORT} localhost:${VNC_PORT} </dev/null >/tmp/live-view.log 2>&1 &
  i=0
  until port_up ${LIVE_VIEW_PORT}; do
    i=$((i + 1)); [ $i -gt 50 ] && { echo "live view did not start" >&2; tail -n 5 /tmp/live-view.log >&2; exit 1; }
    sleep 0.2
  done
fi
cat ${PASSWORD_FILE}`;

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
