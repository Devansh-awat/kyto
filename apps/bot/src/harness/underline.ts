// Underline (owner's ask 2026-10-13). Slack's markdown has no underline — not
// the `markdown` block, not streamed `markdown_text` — so kyto faked it with
// combining low lines that render broken. Only a `rich_text` block can
// underline. So a line the model writes with `<u>…</u>` goes out as a
// rich_text block (its other inline styles converted too) and everything else
// stays markdown.

interface Style {
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
}

type RichElement =
  | { style?: Style; text: string; type: 'text' }
  | { style?: Style; text?: string; type: 'link'; url: string }
  | { type: 'user'; user_id: string }
  | { channel_id: string; type: 'channel' };

interface RichTextBlock {
  elements: (
    | { elements: RichElement[]; type: 'rich_text_section' }
    | {
        elements: { elements: RichElement[]; type: 'rich_text_section' }[];
        style: 'bullet' | 'ordered';
        type: 'rich_text_list';
      }
  )[];
  type: 'rich_text';
}

export type UnderlinePart =
  | { markdown: string }
  | { block: RichTextBlock; fallback: string };

const UNDERLINE = /<u>[\s\S]*?<\/u>/i;
const FENCE = /^\s*(?:```|~~~)/;
const BULLET = /^\s*[-*•]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;

// One inline token at a time, earliest match first. Order matters only for
// matches starting at the same index (`**` before `*`).
const TOKENS: {
  pattern: RegExp;
  apply: (match: RegExpExecArray, style: Style) => RichElement[];
}[] = [
  {
    pattern: /`([^`]+)`/,
    apply: (m, style) => [
      { style: { ...style, code: true }, text: m[1] ?? '', type: 'text' },
    ],
  },
  {
    pattern: /<u>([\s\S]*?)<\/u>/i,
    apply: (m, style) => parseInline(m[1] ?? '', { ...style, underline: true }),
  },
  {
    pattern: /\*\*([^*]+?)\*\*/,
    apply: (m, style) => parseInline(m[1] ?? '', { ...style, bold: true }),
  },
  {
    pattern: /~~([^~]+?)~~/,
    apply: (m, style) => parseInline(m[1] ?? '', { ...style, strike: true }),
  },
  {
    pattern: /(?<![\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/,
    apply: (m, style) => parseInline(m[1] ?? '', { ...style, italic: true }),
  },
  {
    pattern: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,
    apply: (m, style) => [link({ style, text: m[1], url: m[2] ?? '' })],
  },
  {
    pattern: /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/,
    apply: (m, style) => [link({ style, text: m[2], url: m[1] ?? '' })],
  },
  {
    pattern: /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/,
    apply: (m) => [{ type: 'user', user_id: m[1] ?? '' }],
  },
  {
    pattern: /<#(C[A-Z0-9]+)(?:\|[^>]*)?>/,
    apply: (m) => [{ channel_id: m[1] ?? '', type: 'channel' }],
  },
  {
    pattern: /https?:\/\/[^\s<>]+/,
    apply: (m, style) => [link({ style, url: m[0] })],
  },
];

function link({
  style,
  text,
  url,
}: {
  style: Style;
  text?: string;
  url: string;
}): RichElement {
  return {
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...(text ? { text } : {}),
    type: 'link',
    url,
  };
}

function plain(text: string, style: Style): RichElement[] {
  return text
    ? [
        {
          ...(Object.keys(style).length > 0 ? { style } : {}),
          text,
          type: 'text',
        },
      ]
    : [];
}

function parseInline(text: string, style: Style = {}): RichElement[] {
  let best:
    | { index: number; match: RegExpExecArray; token: (typeof TOKENS)[number] }
    | undefined;
  for (const token of TOKENS) {
    const match = token.pattern.exec(text);
    if (match && (best === undefined || match.index < best.index)) {
      best = { index: match.index, match, token };
    }
  }
  if (!best) {
    return plain(text, style);
  }
  return [
    ...plain(text.slice(0, best.index), style),
    ...best.token.apply(best.match, style),
    ...parseInline(text.slice(best.index + best.match[0].length), style),
  ];
}

/** The line as plain text, for notifications and clients without blocks. */
function fallbackText(line: string): string {
  return line.replace(/<\/?u>/gi, '');
}

function lineBlock(line: string): RichTextBlock {
  const bullet = BULLET.exec(line);
  const ordered = ORDERED.exec(line);
  const marker = bullet ?? ordered;
  if (marker) {
    return {
      elements: [
        {
          elements: [
            {
              elements: parseInline(line.slice(marker[0].length)),
              type: 'rich_text_section',
            },
          ],
          style: bullet ? 'bullet' : 'ordered',
          type: 'rich_text_list',
        },
      ],
      type: 'rich_text',
    };
  }
  return {
    elements: [{ elements: parseInline(line), type: 'rich_text_section' }],
    type: 'rich_text',
  };
}

export function hasUnderline(text: string): boolean {
  return UNDERLINE.test(text);
}

/**
 * Split text into markdown runs and one rich_text block per line that holds an
 * underline. Lines inside a code fence, and `<u>` inside inline code, are left
 * as they are.
 */
export function splitUnderlines(text: string): UnderlinePart[] {
  const parts: UnderlinePart[] = [];
  let markdown: string[] = [];
  let inFence = false;
  const flush = () => {
    if (markdown.length > 0) {
      parts.push({ markdown: markdown.join('\n') });
      markdown = [];
    }
  };
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      markdown.push(line);
      continue;
    }
    const outsideCode = line.replace(/`[^`]*`/g, '');
    if (inFence || !hasUnderline(outsideCode)) {
      markdown.push(line);
      continue;
    }
    flush();
    parts.push({ block: lineBlock(line), fallback: fallbackText(line) });
  }
  flush();
  return parts;
}
