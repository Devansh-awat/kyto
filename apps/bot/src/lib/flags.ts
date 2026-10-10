// CLI-style flags at the front of a message to kyto (owner's ask 2026-10-10):
//
//   @kyto --model luna --reasoning high --focusmode @a @b what is …
//
// Only LEADING flags count, so a question that quotes `--model` halfway through
// is never read as one. Pure on purpose: lib/commands applies the result.

interface MessageFlags {
  /** `[]` = focus on the author; `null` = clear; absent = untouched. */
  focus?: string[] | null;
  model?: string;
  reasoning?: string;
  /** The message with the flags taken off — empty when it was only flags. */
  rest: string;
}

const FLAG = /^--([a-z]+)(?:=(\S*))?(?:\s+|$)/i;
const NEXT_TOKEN = /^(\S+)(?:\s+|$)/;
const MENTION = /^<@([UW][A-Z0-9]{6,})(?:\|[^>]+)?>(?:\s+|$)/;
const FOCUS_OFF = /^(?:off|clear|none|stop)(?:\s+|$)/i;

export type ParsedFlags =
  | { error: string; ok: false }
  | { flags: MessageFlags; ok: true };

/** Null when the message doesn't open with a `--flag`. */
export function parseFlags(body: string): ParsedFlags | null {
  let text = body.trim();
  if (!FLAG.test(text)) {
    return null;
  }
  const flags: MessageFlags = { rest: '' };
  for (let match = FLAG.exec(text); match; match = FLAG.exec(text)) {
    const name = (match[1] ?? '').toLowerCase();
    text = text.slice(match[0].length);
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
      return {
        error: `i don't know \`--${name}\`. flags: \`--model\`, \`--reasoning\`, \`--focusmode\`.`,
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
      return { error: `\`--${name}\` needs a value.`, ok: false };
    }
    flags[name] = value;
  }
  flags.rest = text.trim();
  return { flags, ok: true };
}
