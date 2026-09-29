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
