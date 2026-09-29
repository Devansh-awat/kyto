// What kevinton files goes to a PUBLIC GitHub repo, written from Slack threads.
// The prompt forbids quoting or naming anyone; this is the backstop for when a
// model does it anyway — every Slack identifier, link and email address is cut
// before the text leaves. It cannot catch a paraphrase, which is why kevinton
// only reviews PUBLIC channels in the first place (see index.ts).

const REPLACEMENTS: [RegExp, string][] = [
  // <@U123|name>, <#C123|general>, <!subteam^S123>
  [/<[@#!][^>\s]*>/g, '[slack mention]'],
  [/https?:\/\/[\w.-]*slack(?:-files)?\.com\S*/gi, '[slack link]'],
  // Bare user/channel/team ids: U0BD3555UCQ, C06QV2T1P4G. They always carry a
  // digit; requiring one spares words like UNDEFINED or CONNECTION.
  [/\b[UCDGWBTS](?=[A-Z0-9]*\d)[A-Z0-9]{8,12}\b/g, '[slack id]'],
  // Message timestamps: 1710818631.730789
  [/\b\d{10}\.\d{6}\b/g, '[timestamp]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
];

export function scrubForPublic(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Words that run together in a person's message and in what kevinton wrote.
// Five is long enough that ordinary phrasing ("kyto did not reply to the")
// rarely collides with a real message, and short enough to catch a quote.
const QUOTE_WORDS = 5;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * The first run of QUOTE_WORDS consecutive words `text` shares with any of
 * `messages`, or undefined. The prompt forbids quoting people; this is what
 * makes it true, since a model told not to quote will still do it (it did, on
 * the first live review).
 */
export function findQuote({
  messages,
  text,
}: {
  messages: string[];
  text: string;
}): string | undefined {
  const seen = new Set<string>();
  for (const message of messages) {
    const list = words(message);
    for (let index = 0; index + QUOTE_WORDS <= list.length; index += 1) {
      seen.add(list.slice(index, index + QUOTE_WORDS).join(' '));
    }
  }
  const own = words(text);
  for (let index = 0; index + QUOTE_WORDS <= own.length; index += 1) {
    const run = own.slice(index, index + QUOTE_WORDS).join(' ');
    if (seen.has(run)) {
      return run;
    }
  }
  return;
}
