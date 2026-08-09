// Adding a custom emoji to the workspace, directly.
//
// Slack has no public API for this. `emoji.add` is an internal endpoint that
// only accepts a BROWSER SESSION: an `xoxc-` token plus the matching `d`
// cookie, both copied out of devtools while adding an emoji by hand. That is
// exactly what #emojibot (github.com/taciturnaxolotl/emojibot) does, and there
// is no other way — an app-scoped token is refused outright.
//
// What that pair is worth is the thing to keep in mind: it is not a scoped
// credential, it is a whole Slack account. It can read every DM that account
// can read and post anywhere as them, with no scopes to narrow it and nothing
// in the audit trail separating kyto from the person. So:
//
//   - it is the OWNER's, by his decision (2026-08-09), and anyone may trigger
//     an upload with it — the emoji all land under his name;
//   - it lives in the environment, never in the database and never in a
//     sandbox, and is never logged, not even truncated;
//   - it is reachable ONLY through the two calls below. There is deliberately
//     no "call Slack as the owner" helper built on it, because a general one
//     would hand every prompt injection the owner's account.
//
// A per-day cap per requester sits on top: the account is the owner's, so a
// user who asks for two hundred emoji is spending his reputation, not kyto's.

import { env } from '@/env';
import logger from '@/lib/logger';

const EMOJI_ADD_URL = 'https://slack.com/api/emoji.add';
const EMOJI_REMOVE_URL = 'https://slack.com/api/emoji.remove';
const UPLOAD_TIMEOUT_MS = 30_000;

// How many emoji one person can add per UTC day. Deliberately in memory: it
// resets on restart, which is the honest trade for not adding a table to hold
// a counter. It is a spam brake, not a security boundary — the real limit is
// that every upload is logged with who asked.
const DAILY_LIMIT_PER_USER = 10;
const uploads = new Map<string, number>();

export function emojiUploadConfigured(): boolean {
  return Boolean(env.SLACK_EMOJI_TOKEN && env.SLACK_EMOJI_COOKIE);
}

/**
 * The `d` cookie, as a Cookie header.
 *
 * Accepts either the whole header line copied from devtools (`d=xoxd-…; d-s=…`)
 * or the bare value, because both are what someone actually has in hand.
 */
function cookieHeader(raw: string): string {
  return raw.includes('=') ? raw : `d=${raw}`;
}

function quotaKey(userId: string): string {
  return `${userId}:${new Date().toISOString().slice(0, 10)}`;
}

interface EmojiResult {
  error?: string;
  ok: boolean;
}

async function callEmojiApi(url: string, body: FormData): Promise<EmojiResult> {
  const token = env.SLACK_EMOJI_TOKEN;
  const cookie = env.SLACK_EMOJI_COOKIE;
  if (!(token && cookie)) {
    return { error: 'not_configured', ok: false };
  }
  body.set('token', token);
  const response = await fetch(url, {
    body,
    headers: { Cookie: cookieHeader(cookie) },
    method: 'POST',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  // A session that has been logged out answers with HTML, not JSON.
  const parsed = (await response
    .json()
    .catch(() => null)) as EmojiResult | null;
  if (!parsed) {
    return { error: 'invalid_response', ok: false };
  }
  return parsed;
}

/**
 * Add one custom emoji. Returns Slack's own error code on failure — the useful
 * ones are `error_name_taken`, `error_bad_name_i18n`, `invalid_auth` (the
 * session has expired and the owner must re-copy the pair) and `ratelimited`.
 */
export async function addEmoji({
  bytes,
  filename,
  name,
  requestedBy,
}: {
  bytes: Uint8Array;
  filename: string;
  name: string;
  requestedBy: string;
}): Promise<EmojiResult> {
  const key = quotaKey(requestedBy);
  const used = uploads.get(key) ?? 0;
  if (used >= DAILY_LIMIT_PER_USER) {
    return { error: 'kyto_daily_limit', ok: false };
  }
  const body = new FormData();
  body.set('mode', 'data');
  body.set('name', name);
  body.set('image', new Blob([bytes]), filename);
  const result = await callEmojiApi(EMOJI_ADD_URL, body);
  if (result.ok) {
    uploads.set(key, used + 1);
  }
  // Who asked matters more than usual here: the emoji is added under the
  // owner's account, so this log is the only record of who it was really for.
  logger.info(
    { error: result.error, name, ok: result.ok, requestedBy },
    '[emoji] direct upload'
  );
  return result;
}

/** Remove a custom emoji. Slack only allows this for the account that added it. */
export async function removeEmoji({
  name,
  requestedBy,
}: {
  name: string;
  requestedBy: string;
}): Promise<EmojiResult> {
  const body = new FormData();
  body.set('name', name);
  const result = await callEmojiApi(EMOJI_REMOVE_URL, body);
  logger.info(
    { error: result.error, name, ok: result.ok, requestedBy },
    '[emoji] direct removal'
  );
  return result;
}
