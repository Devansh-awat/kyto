// Slack's search token for a message, by channel and ts, as the APP's
// connection received it. A message that pings both kytos runs two turns, and
// the account's turn can be built from its own client socket, which never
// carries the app's token — so searchSlack in that turn said "no assistant
// search token" for a message that did @mention kyto (issue #33). Either turn
// for the same message can now find it here.

// Slack's token lasts ~2 minutes; past that it is useless anyway.
const TTL_MS = 3 * 60 * 1000;

const tokens = new Map<string, { at: number; token: string }>();

export function rememberActionToken({
  channel,
  token,
  ts,
}: {
  channel: string;
  token: string;
  ts: string;
}): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of tokens) {
    if (entry.at < cutoff) {
      tokens.delete(key);
    }
  }
  tokens.set(`${channel}:${ts}`, { at: Date.now(), token });
}

export function recallActionToken({
  channel,
  ts,
}: {
  channel: string;
  ts: string;
}): string | undefined {
  const entry = tokens.get(`${channel}:${ts}`);
  return entry && entry.at >= Date.now() - TTL_MS ? entry.token : undefined;
}
