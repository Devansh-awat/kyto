import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { slack } from '@/lib/chat';
import logger from '@/lib/logger';
import {
  mayReadChannel,
  PRIVATE_CHANNEL_REFUSAL,
} from '@/lib/slack/channel-access';

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
const SLACK_PROXY_PREFIX = '/_slackapi/';

// An hour, like the GitHub proxy's: a turn may run commands for 20 minutes
// each, and a token that expired mid-turn turned `slack` into a silent 401.
const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000;

// Slack calls one turn's sandbox may make. A script paging every channel's
// history in a loop would otherwise run the app into Slack's rate limits, which
// are shared with every other turn and with kyto's own replies.
const SLACK_CALL_BUDGET = 300;

interface ProxyToken {
  calls: number;
  /** The turn's own channel: always readable. */
  channelId?: string;
  expiry: number;
  /** Whom reads are made for — the private-channel rule is checked against them. */
  userId?: string;
}

// Per-turn secrets. In-memory only; a restart invalidates all (turns don't
// survive restarts anyway).
const tokens = new Map<string, ProxyToken>();

/** Mint a per-turn proxy secret valid for the turn (bounded by a TTL). */
export function registerProxyToken({
  channelId,
  userId,
}: {
  channelId?: string;
  userId?: string;
}): string {
  const secret = randomBytes(24).toString('base64url');
  tokens.set(secret, {
    calls: 0,
    channelId,
    expiry: Date.now() + PROXY_TOKEN_TTL_MS,
    userId,
  });
  return secret;
}

export function revokeProxyToken(secret: string | undefined): void {
  if (secret) {
    tokens.delete(secret);
    suspended.delete(secret);
  }
}

// Tokens switched off for a while (an OpenCode run).
const suspended = new Map<string, ProxyToken>();

/**
 * Switch a token off until the returned function is called. A token revoked in
 * the meantime (the turn ended) stays revoked.
 */
export function suspendProxyToken(secret: string): () => void {
  const token = tokens.get(secret);
  if (token === undefined) {
    return () => undefined;
  }
  tokens.delete(secret);
  suspended.set(secret, token);
  return () => {
    const kept = suspended.get(secret);
    if (kept !== undefined) {
      suspended.delete(secret);
      tokens.set(secret, kept);
    }
  };
}

function liveToken(secret: string | undefined): ProxyToken | undefined {
  if (!secret) {
    return;
  }
  const token = tokens.get(secret);
  if (!token) {
    return;
  }
  if (Date.now() > token.expiry) {
    tokens.delete(secret);
    return;
  }
  return token;
}

// Methods whose result lists conversations or items from many conversations:
// entries the requester may not read are dropped from the answer.
const LISTING_METHODS = new Set(['conversations.list', 'users.conversations']);

const conversationSchema = z.looseObject({
  id: z.string().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
});
const reactionItemSchema = z.looseObject({ channel: z.string().optional() });

function isPublicListing(entry: object): boolean {
  const parsed = conversationSchema.safeParse(entry);
  return (
    parsed.success &&
    parsed.data.is_private === false &&
    parsed.data.is_im !== true &&
    parsed.data.is_mpim !== true
  );
}

async function readableOnly<T extends { channel?: string; id?: string }>({
  entries,
  key,
  token,
}: {
  entries: T[];
  key: 'channel' | 'id';
  token: ProxyToken;
}): Promise<T[]> {
  const kept: T[] = [];
  for (const entry of entries) {
    const channelId = entry[key];
    // A listing entry Slack itself marks public is readable by anyone in the
    // workspace. Probing each one with conversations.info, one at a time, made
    // `conversations.list` of public channels time out before it answered
    // (#132); only the rest still need the asker's membership checked.
    if (channelId && isPublicListing(entry)) {
      kept.push(entry);
      continue;
    }
    if (
      channelId &&
      (await mayReadChannel({
        askerUserId: token.userId,
        channelId,
        currentChannelId: token.channelId,
      }))
    ) {
      kept.push(entry);
    }
  }
  return kept;
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
  const token = liveToken(secret);
  if (!token) {
    return json({ error: 'unauthorized', ok: false }, 401);
  }
  let method: string;
  try {
    method = decodeURIComponent(pathname.slice(SLACK_PROXY_PREFIX.length));
  } catch {
    return json({ error: 'invalid_method', ok: false }, 400);
  }
  if (!READ_ONLY_METHODS.has(method)) {
    return json({ error: `method_not_allowed: ${method}`, ok: false }, 403);
  }
  token.calls += 1;
  if (token.calls > SLACK_CALL_BUDGET) {
    return json(
      {
        error: `turn_budget_exceeded: this turn already made ${SLACK_CALL_BUDGET} Slack calls. Narrow the query (in:#channel, a date range, fewer pages) instead of reading more.`,
        ok: false,
      },
      429
    );
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
  // The same rule the read tools apply: a private channel or DM other than the
  // turn's own is readable only for a member of it.
  const target = args.channel ?? args.channel_id;
  if (
    typeof target === 'string' &&
    !(await mayReadChannel({
      askerUserId: token.userId,
      channelId: target,
      currentChannelId: token.channelId,
    }))
  ) {
    return json({ error: PRIVATE_CHANNEL_REFUSAL, ok: false }, 403);
  }
  try {
    const result = z
      .looseObject({ channels: z.unknown(), items: z.unknown() })
      .partial()
      .parse(await slack.webClient.apiCall(method, args));
    if (LISTING_METHODS.has(method) && Array.isArray(result.channels)) {
      result.channels = await readableOnly({
        entries: z.array(conversationSchema).parse(result.channels),
        key: 'id',
        token,
      });
    }
    if (method === 'reactions.list' && Array.isArray(result.items)) {
      result.items = await readableOnly({
        entries: z.array(reactionItemSchema).parse(result.items),
        key: 'channel',
        token,
      });
    }
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
 * Installs `slack <method> [jsonArgs]` as a real executable on PATH, and
 * `slack-history`, which pages one channel's history into a local file and
 * prints only its coverage (#122: "index the whole channel" was a hand-written
 * paging script every time, and its 12k-char stdout cap hid the messages). ANY
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
chmod +x /usr/local/bin/slack
cat > /usr/local/bin/slack-history <<'KYTO_SLACK_HISTORY'
#!/usr/bin/env python3
"""slack-history - page a channel's history into a local file, read-only.

  usage:  slack-history <channel id> [--limit N | --all] [--since YYYY-MM-DD]
                        [--threads] [--out FILE]

Writes one JSON object per message (oldest first) to FILE, default
/tmp/slack-history/<channel>.jsonl, and prints ONLY a coverage summary:
how many messages, the oldest/newest dates, whether the channel's history
was exhausted, and why it stopped. Search and summarise the FILE with
python/grep/jq afterwards instead of printing all of it.

  --limit N   newest N messages (default 1000)
  --all       page until the history is exhausted or the turn's Slack
              call budget runs out (the summary says which)
  --since D   stop at messages older than this date (UTC)
  --threads   also fetch each thread's replies (one call per thread)
"""
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

PAGE = 999


def usage(code):
    print(__doc__.strip(), file=sys.stderr if code else sys.stdout)
    sys.exit(code)


def call(method, args):
    proxy = os.environ.get("KYTO_SLACK_PROXY")
    token = os.environ.get("KYTO_SLACK_PROXY_TOKEN")
    if not (proxy and token):
        return {"ok": False, "error": "slack proxy is not available in this context"}
    request = urllib.request.Request(
        f"{proxy}/{method}",
        data=json.dumps(args).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read() or b"{}")
        except ValueError:
            return {"ok": False, "error": f"http {error.code}"}
    except Exception as error:  # a network blip ends the walk, reported below
        return {"ok": False, "error": str(error)}


def day(ts):
    return datetime.fromtimestamp(float(ts), timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def slim(message):
    out = {k: message[k] for k in ("ts", "user", "bot_id", "subtype", "thread_ts", "reply_count") if k in message}
    out["text"] = message.get("text", "")
    files = [f.get("name") for f in message.get("files", []) if f.get("name")]
    if files:
        out["files"] = files
    return out


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        usage(0)
    channel, rest = argv[0], argv[1:]
    limit, every, since, threads, out = 1000, False, None, False, None
    i = 0
    while i < len(rest):
        flag = rest[i]
        if flag == "--all":
            every = True
        elif flag == "--threads":
            threads = True
        elif flag in ("--limit", "--since", "--out") and i + 1 < len(rest):
            value = rest[i + 1]
            i += 1
            if flag == "--limit":
                if not value.isdigit() or int(value) < 1:
                    usage(2)
                limit = int(value)
            elif flag == "--since":
                try:
                    since = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
                except ValueError:
                    usage(2)
            else:
                out = value
        else:
            print(f"slack-history: unknown argument {flag!r}", file=sys.stderr)
            usage(2)
        i += 1
    out = out or f"/tmp/slack-history/{channel}.jsonl"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    messages, cursor, pages, stopped, exhausted = [], None, 0, None, False
    while True:
        args = {"channel": channel, "limit": PAGE}
        if cursor:
            args["cursor"] = cursor
        if since:
            args["oldest"] = f"{since:.6f}"
        page = call("conversations.history", args)
        if not page.get("ok"):
            stopped = page.get("error", "unknown error")
            break
        pages += 1
        messages.extend(page.get("messages", []))
        cursor = (page.get("response_metadata") or {}).get("next_cursor")
        if not (page.get("has_more") and cursor):
            exhausted = True
            break
        if not every and len(messages) >= limit:
            stopped = f"reached --limit {limit}"
            break
    if not every:
        messages = messages[:limit]
    messages.sort(key=lambda m: float(m.get("ts", 0)))

    fetched_threads, thread_stop = 0, None
    replies = {}
    if threads and not stopped:
        for parent in messages:
            if not parent.get("reply_count"):
                continue
            got, cursor = [], None
            while True:
                args = {"channel": channel, "ts": parent["ts"], "limit": PAGE}
                if cursor:
                    args["cursor"] = cursor
                page = call("conversations.replies", args)
                if not page.get("ok"):
                    thread_stop = page.get("error", "unknown error")
                    break
                got.extend(m for m in page.get("messages", []) if m.get("ts") != parent["ts"])
                cursor = (page.get("response_metadata") or {}).get("next_cursor")
                if not (page.get("has_more") and cursor):
                    break
            if thread_stop:
                break
            replies[parent["ts"]] = got
            fetched_threads += 1

    count = 0
    with open(out, "w") as handle:
        for message in messages:
            handle.write(json.dumps(slim(message), ensure_ascii=False) + "\\n")
            count += 1
            for reply in replies.get(message.get("ts"), []):
                handle.write(json.dumps(slim(reply), ensure_ascii=False) + "\\n")
                count += 1

    summary = {
        "channel": channel,
        "file": out,
        "messages": len(messages),
        "linesWritten": count,
        "oldest": day(messages[0]["ts"]) if messages else None,
        "newest": day(messages[-1]["ts"]) if messages else None,
        "pages": pages,
        "exhausted": exhausted,
        "complete": exhausted and not stopped,
        "stoppedBecause": stopped,
    }
    if since:
        summary["since"] = day(since)
    if threads:
        with_replies = sum(1 for m in messages if m.get("reply_count"))
        summary["threads"] = {"withReplies": with_replies, "fetched": fetched_threads, "stoppedBecause": thread_stop}
    print(json.dumps(summary, indent=1))
    if not exhausted:
        print(
            "Not the whole channel: older history exists beyond what was fetched. Say so when you report on it.",
            file=sys.stderr,
        )


main(sys.argv[1:])
KYTO_SLACK_HISTORY
chmod +x /usr/local/bin/slack-history`;
}
