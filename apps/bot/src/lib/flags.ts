// CLI-style flags at the front of a message to kyto (owner's ask 2026-10-10):
//
//   @kyto --model luna --reasoning high --focusmode @a @b what is …
//
// `--no-memory` and `--NO-MEMORY` are told apart by CASE (owner's ask
// 2026-10-11): lowercase keeps the memories in the prompt but says they may be
// stale, capitals hide every kind of memory. `--memory` turns either off.
//
// Flags may also END a line (owner's call 2026-10-13: "… on a new message
// --reasoning high" was ignored). There only KNOWN flags with a valid value
// count, outside code, so a question that quotes `--model` ("what does --model
// do?") is never read as one. Pure on purpose: lib/commands applies the result.

interface MessageFlags {
  /** `[]` = focus on the author; `null` = clear; absent = untouched. */
  focus?: string[] | null;
  /** `stale` = shown but distrusted; `off` = hidden; `null` = back to normal. */
  memory?: 'off' | 'stale' | null;
  model?: string;
  /** `--no-redact`: this ONE message's turn reads email unredacted (owner only). */
  noRedact?: true;
  reasoning?: string;
  /** The message with the flags taken off — empty when it was only flags. */
  rest: string;
}

const FLAG = /^--([a-z][a-z-]*)(?:=(\S*))?(?:\s+|$)/i;
const NEXT_TOKEN = /^(\S+)(?:\s+|$)/;
const MENTION = /^<@([UW][A-Z0-9]{6,})(?:\|[^>]+)?>(?:\s+|$)/;
const FOCUS_OFF = /^(?:off|clear|none|stop)(?:\s+|$)/i;

export type ParsedFlags =
  | { error: string; ok: false }
  | { flags: MessageFlags; ok: true };

// kyto's own model names; `MODEL_CHOICES` is keyed by exactly these.
export const SHARED_MODEL_NAMES = ['glm', 'haiku', 'luna'] as const;
// What `--model`/`--reasoning` may say when the flag ends a line rather than
// opening the message: a value that reads like prose is prose.
const TRAILING_MODEL = new RegExp(
  `^(?:${SHARED_MODEL_NAMES.join('|')}|default|random|reset|clear|off|[\\w.-]+\\/[\\w.:@-]+)$`,
  'i'
);
const TRAILING_REASONING =
  /^(?:none|minimal|low|medium|high|xhigh|default|random|reset|clear|off)$/i;
const FLAG_START = /(?:^|\s)--[a-z]/gi;

/** Null when the message has no `--flag` at its start or ending a line. */
export function parseFlags(body: string): ParsedFlags | null {
  const text = body.trim();
  if (FLAG.test(text)) {
    return readFlags({ strict: false, text });
  }
  return trailingFlags(text);
}

// Flags ending a line, outside code: the first line whose tail is nothing but
// known, valid flags. Never an error — anything doubtful is left as text.
function trailingFlags(text: string): ParsedFlags | null {
  const lines = text.split('\n');
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    for (const match of line.matchAll(FLAG_START)) {
      const start = match.index + match[0].indexOf('--');
      // Inside inline code: an odd number of backticks before it.
      if ((line.slice(0, start).match(/`/g)?.length ?? 0) % 2 === 1) {
        continue;
      }
      const parsed = readFlags({ strict: true, text: line.slice(start) });
      if (!parsed?.ok || parsed.flags.rest) {
        continue;
      }
      const kept = [
        ...lines.slice(0, index),
        line.slice(0, start).trimEnd(),
        ...lines.slice(index + 1),
      ];
      parsed.flags.rest = kept.join('\n').trim();
      return parsed;
    }
  }
  return null;
}

function readFlags({
  strict,
  text: input,
}: {
  /** A flag ending a line: unknown or doubtful means "not flags", not an error. */
  strict: boolean;
  text: string;
}): ParsedFlags | null {
  let text = input.trim();
  const flags: MessageFlags = { rest: '' };
  for (let match = FLAG.exec(text); match; match = FLAG.exec(text)) {
    const raw = match[1] ?? '';
    const name = raw.toLowerCase();
    text = text.slice(match[0].length);
    if (name === 'no-memory') {
      flags.memory = raw === 'NO-MEMORY' ? 'off' : 'stale';
      continue;
    }
    if (name === 'no-redact') {
      flags.noRedact = true;
      continue;
    }
    if (name === 'memory') {
      flags.memory = null;
      continue;
    }
    if (name === 'focus' || name === 'focusmode') {
      const off = FOCUS_OFF.exec(text);
      if (off) {
        flags.focus = null;
        text = text.slice(off[0].length);
        continue;
      }
      const ids: string[] = [];
      for (let m = MENTION.exec(text); m; m = MENTION.exec(text)) {
        ids.push(m[1] ?? '');
        text = text.slice(m[0].length);
      }
      flags.focus = ids;
      continue;
    }
    if (name !== 'model' && name !== 'reasoning') {
      return strict
        ? null
        : {
            error: `i don't know \`--${raw}\`. flags: \`--model\`, \`--reasoning\`, \`--focusmode\`, \`--no-memory\`, \`--NO-MEMORY\`, \`--memory\`, \`--no-redact\`.`,
            ok: false,
          };
    }
    let value = match[2];
    if (value === undefined) {
      const next = NEXT_TOKEN.exec(text);
      value = next?.[1];
      text = next ? text.slice(next[0].length) : text;
    }
    if (!value || value.startsWith('--')) {
      return strict
        ? null
        : { error: `\`--${name}\` needs a value.`, ok: false };
    }
    const plausible = (
      name === 'model' ? TRAILING_MODEL : TRAILING_REASONING
    ).test(value);
    if (strict && !plausible) {
      return null;
    }
    flags[name] = value;
  }
  flags.rest = text.trim();
  return { flags, ok: true };
}

const LEADING_MENTIONS = /^\s*(?:<@[A-Z0-9][A-Z0-9._-]*(?:\|[^>]+)?>\s*)*/;

/**
 * The message as a model should read it: leading flags taken off, leading
 * mentions kept. The flags are settings for the harness, already applied — a
 * model that sees `--model luna` starts talking about which model it is on.
 * Unparseable flags are left alone: that message got an error, not a turn.
 */
export function withoutFlags(text: string): string {
  const mentions = LEADING_MENTIONS.exec(text)?.[0] ?? '';
  const parsed = parseFlags(text.slice(mentions.length));
  return parsed?.ok ? `${mentions}${parsed.flags.rest}` : text;
}
