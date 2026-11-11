// One hook every piece of text kyto sends to Slack passes through, installed by
// the app at boot (lib/redact). It lives here, not in lib/, because the harness
// must not import app code — the app hands it a function instead.
//
// Identity by default, so a harness used without the app (tests) sends text
// exactly as given.

type TextFilter = (text: string) => string;

let filter: TextFilter = (text) => text;

export function setOutboundFilter(next: TextFilter): void {
  filter = next;
}

// The prompt's private-memory block (lib/agent/thinking-render) opens with this
// exact tag and first line. Nobody in Slack may see it or what it carries
// (#223), whichever path put it in a message. Only that block goes: a reply that
// merely mentions the tag keeps everything around it.
const THINKING_OPEN = '<your_previous_thinking>\nYour own private reasoning';
const THINKING_CLOSE = '</your_previous_thinking>';
// A block that never closes (the model echoed the opening and stopped, was cut
// off, or went on to write its real answer) must not take that answer with it:
// then only the opening and its fixed intro paragraph go, up to the first blank
// line, and the rest of the text is kept.
const THINKING_BLOCK = new RegExp(
  `${THINKING_OPEN}[\\s\\S]*?${THINKING_CLOSE}|${THINKING_OPEN}[^\\n]*(?:\\n(?!\\n)[^\\n]*)*`,
  'g'
);

export function filterOutbound(text: string): string {
  return filter(text.replace(THINKING_BLOCK, ''));
}

/**
 * Every string inside plain objects and arrays, e.g. Block Kit blocks or a task
 * card chunk. Anything that is not a plain object (a Uint8Array, a Date) is
 * passed through untouched — walking one would turn it into `{}`.
 */
export function filterOutboundDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return filterOutbound(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => filterOutboundDeep(item)) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        filterOutboundDeep(item),
      ])
    ) as T;
  }
  return value;
}

/**
 * `filterOutbound` for text that arrives in pieces: a private-thinking block
 * opened in one piece stays dropped until a piece closes it (#223), where the
 * stateless filter would let its inner lines through. The tail of a piece that
 * could still become the opening is held for the next one.
 *
 * `flush()` ends the stream. A block still open then never closed, so what was
 * held back is released minus the opening and its intro paragraph (see
 * THINKING_BLOCK): a reply is never lost to a missing closing tag.
 */
export function createStreamFilter(): {
  flush: () => string;
  push: (text: string) => string;
} {
  let swallowed: string | undefined;
  let held = '';
  const push = (piece: string): string => {
    let rest = held + piece;
    held = '';
    let out = '';
    while (rest) {
      if (swallowed !== undefined) {
        const end = rest.indexOf(THINKING_CLOSE);
        if (end === -1) {
          swallowed += rest;
          break;
        }
        rest = rest.slice(end + THINKING_CLOSE.length);
        swallowed = undefined;
        continue;
      }
      const start = rest.indexOf(THINKING_OPEN);
      if (start === -1) {
        let keep = 0;
        for (
          let n = Math.min(THINKING_OPEN.length - 1, rest.length);
          n > 0;
          n -= 1
        ) {
          if (THINKING_OPEN.startsWith(rest.slice(rest.length - n))) {
            keep = n;
            break;
          }
        }
        held = rest.slice(rest.length - keep);
        out += rest.slice(0, rest.length - keep);
        break;
      }
      out += rest.slice(0, start);
      swallowed = THINKING_OPEN;
      rest = rest.slice(start + THINKING_OPEN.length);
    }
    return filterOutbound(out);
  };
  return {
    flush: () => {
      const rest = held + (swallowed ?? '');
      held = '';
      swallowed = undefined;
      return filterOutbound(rest).replace(/^\s+/, '');
    },
    push,
  };
}
