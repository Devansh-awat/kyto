// Adding a custom emoji to the workspace, directly.
//
// Slack has no public API for this. `emoji.add` is an internal endpoint that
// only accepts a BROWSER SESSION: an `xoxc-` token plus the matching `d`
// cookie, both copied out of devtools while adding an emoji by hand. That is
// exactly what #emojibot (github.com/taciturnaxolotl/emojibot) does, and there
// is no other way — an app-scoped token is refused outright.
//
// The pair belongs to kyto's OWN Slack user account (since 2026-09-29; before
// that it was the owner's), so every emoji lands under "kyto". It is still a
// whole account with no scopes, so it lives in the environment only — see
// KYTO_USER_TOKEN in env.ts for everything else allowed to use it.
//
// A per-day cap per requester sits on top: every upload goes out under one
// shared account, so a user who asks for two hundred emoji spends its
// reputation, not their own.

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
  return Boolean(env.KYTO_USER_TOKEN && env.KYTO_USER_COOKIE);
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
  const token = env.KYTO_USER_TOKEN;
  const cookie = env.KYTO_USER_COOKIE;
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
 * session has expired and the pair must be re-copied) and `ratelimited`.
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
  // Who asked matters more than usual here: the emoji is added under kyto's
  // shared user account, so this log is the only record of who it was really for.
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
