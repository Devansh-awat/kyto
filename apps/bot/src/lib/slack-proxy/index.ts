import { randomBytes } from 'node:crypto';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';

// A host-side, READ-ONLY Slack proxy the sandbox can call so a script can batch
// Slack reads (e.g. "who is in the most channels") without N LLM round-trips —
// and without the bot token ever entering the sandbox. The sandbox authenticates
// with a per-turn secret; the proxy attaches the real token and forwards ONLY
// the allow-listed read methods. Even a leaked per-turn secret can therefore
// never post, delete, or mutate anything.

// Read-only Web API methods. Deliberately excludes every write/admin method
// (chat.*, conversations.invite/kick/archive, files upload, admin.*, etc.).
const READ_ONLY_METHODS = new Set<string>([
  'auth.test',
  'bookmarks.list',
  'conversations.history',
  'conversations.info',
  'conversations.members',
  'conversations.replies',
  'conversations.list',
  'emoji.list',
  'pins.list',
  'reactions.get',
  'reactions.list',
  'team.info',
  'team.profile.get',
  'usergroups.list',
  'usergroups.users.list',
  'users.conversations',
  'users.getPresence',
  'users.info',
  'users.list',
  'users.lookupByEmail',
  'users.profile.get',
]);

// Where the proxy is mounted on the public sites server.
export const SLACK_PROXY_PREFIX = '/_slackapi/';

const PROXY_TOKEN_TTL_MS = 15 * 60 * 1000;

// Per-turn secrets → expiry. In-memory only; a restart invalidates all (turns
// don't survive restarts anyway).
const tokens = new Map<string, number>();

/** Mint a per-turn proxy secret valid for the turn (bounded by a TTL). */
export function registerProxyToken(): string {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, Date.now() + PROXY_TOKEN_TTL_MS);
  return secret;
}

export function revokeProxyToken(secret: string | undefined): void {
  if (secret) {
    tokens.delete(secret);
  }
}

function isValidToken(secret: string | undefined): boolean {
  if (!secret) {
    return false;
  }
  const expiry = tokens.get(secret);
  if (!expiry) {
    return false;
  }
  if (Date.now() > expiry) {
    tokens.delete(secret);
    return false;
  }
  return true;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

/**
 * Handle a request to the Slack proxy, or return null if the path isn't ours
 * (so the caller falls through to normal static-site serving). Only reachable
 * over the public sites host; every call is secret-gated and method-gated.
 */
export async function handleSlackProxy(
  request: Request,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith(SLACK_PROXY_PREFIX)) {
    return null;
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed', ok: false }, 405);
  }
  const auth = request.headers.get('authorization') ?? '';
  const secret = auth.replace(/^Bearer\s+/i, '').trim();
  if (!isValidToken(secret)) {
    return json({ error: 'unauthorized', ok: false }, 401);
  }
  const method = decodeURIComponent(pathname.slice(SLACK_PROXY_PREFIX.length));
  if (!READ_ONLY_METHODS.has(method)) {
    return json({ error: `method_not_allowed: ${method}`, ok: false }, 403);
  }
  let args: Record<string, unknown> = {};
  const rawBody = await request.text().catch(() => '');
  if (rawBody.trim()) {
    try {
      args = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid_json_body', ok: false }, 400);
    }
  }
  try {
    const result = await slack.webClient.apiCall(method, args);
    return json(result, 200);
  } catch (error) {
    logger.warn({ err: error, method }, '[slack-proxy] call failed');
    return json(
      {
        error: error instanceof Error ? error.message : 'call_failed',
        ok: false,
      },
      502
    );
  }
}

/** The allow-listed method names (for tool/prompt documentation). */
export const readOnlySlackMethods = (): string[] =>
  [...READ_ONLY_METHODS].sort();

/** Env that points a sandbox command at the proxy. Re-sent on every command, so
 * a resumed sandbox never carries a stale (revoked) token from an older turn. */
export function slackProxyEnv(
  secret: string,
  publicHost: string
): Record<string, string> {
  return {
    KYTO_SLACK_PROXY: `https://${publicHost}/_slackapi`,
    KYTO_SLACK_PROXY_TOKEN: secret,
  };
}

/**
 * Installs `slack <method> [jsonArgs]` as a real executable on PATH, so ANY
 * command in the sandbox can query Slack read-only — the plain `bash` tool and a
 * recurring `bash` reminder, not just the `slackScript` tool (which used to
 * prepend the helper as a shell function, making it invisible everywhere else).
 *
 * It reads the proxy URL and token from the environment at call time, which is
 * what lets a sandbox outlive any single turn's token: each command is handed a
 * fresh one. Idempotent — this reruns on every materialization.
 */
export function slackHelperInstall(): string {
  return `cat > /usr/local/bin/slack <<'KYTO_SLACK_HELPER'
#!/usr/bin/env bash
set -euo pipefail

# Every method the host-side proxy will forward. Checked here as well as there,
# so a wrong guess costs a local error naming the alternatives instead of a
# round trip that comes back as a bare 403.
METHODS="${readOnlySlackMethods().join(' ')}"

usage() {
  cat <<'KYTO_SLACK_USAGE'
slack — query the Slack Web API, READ-ONLY, through kyto's host-side proxy.

  usage:  slack <api.method> ['<json arguments>']

  There are NO options. This is not curl and not the official Slack CLI: the
  only arguments are an API method name and, optionally, ONE single-quoted JSON
  object. It prints the raw JSON response on stdout.

  examples:
    slack auth.test
    slack conversations.replies '{"channel":"C0123","ts":"1710818631.730789"}'
    slack conversations.list '{"limit":1000,"types":"public_channel"}' | jq '.channels | length'
    slack users.info '{"user":"U0123"}' | jq -r '.user.profile.real_name'

  paging:   pass .response_metadata.next_cursor back as {"cursor":"..."}
  writing:  impossible. Posting, editing, deleting and every admin method are
            not proxied at all, and the Slack token is not in this sandbox.

  methods:
KYTO_SLACK_USAGE
  printf '    %s\\n' $METHODS
}

if [ "$#" -eq 0 ] || [ "\${1:-}" = "--help" ] || [ "\${1:-}" = "-h" ] || [ "\${1:-}" = "help" ]; then
  usage
  exit 0
fi

case "$1" in
  -*)
    echo "slack: '$1' is not an option — this command takes no flags." >&2
    usage >&2
    exit 2
    ;;
esac

method="$1"
case " $METHODS " in
  *" $method "*) ;;
  *)
    echo "slack: '$method' is not available (read-only proxy)." >&2
    echo "slack: available methods:" >&2
    printf '    %s\\n' $METHODS >&2
    exit 2
    ;;
esac

if [ "$#" -gt 2 ]; then
  echo "slack: expected at most 2 arguments, got $#. Wrap the JSON in SINGLE quotes so the shell passes it as one argument." >&2
  exit 2
fi

if [ "$#" -eq 2 ]; then body="$2"; else body='{}'; fi
case "$body" in
  '{'*'}') ;;
  *)
    echo "slack: the second argument must be a JSON object like '{\\"channel\\":\\"C0123\\"}' — got: $body" >&2
    exit 2
    ;;
esac
if command -v jq >/dev/null 2>&1 && ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
  echo "slack: the second argument is not valid JSON: $body" >&2
  exit 2
fi

if [ -z "\${KYTO_SLACK_PROXY:-}" ] || [ -z "\${KYTO_SLACK_PROXY_TOKEN:-}" ]; then
  echo '{"ok":false,"error":"slack proxy is not available in this context"}' >&2
  exit 1
fi

# --max-time so a hung proxy fails the command instead of holding the whole turn.
curl -sS --max-time 60 -X POST "$KYTO_SLACK_PROXY/$method" \\
  -H "Authorization: Bearer $KYTO_SLACK_PROXY_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d "$body"
printf '\\n'
KYTO_SLACK_HELPER
chmod +x /usr/local/bin/slack`;
}
