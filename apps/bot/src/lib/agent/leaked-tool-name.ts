import { FAMILY_OF } from '@/lib/ai/merge-tools';

// A model that drops the tool-call channel for a moment writes the NAME of the
// tool it meant to call into the reply: messages ended in the literal text
// `canvasRead` (#123) and `codeMode`. Nobody reading Slack should see one.
//
// Only a camelCase tool name kyto knows — the family actions plus every tool a
// turn registered (`noteToolNames`) — and only at the very END of the text, on
// a line of its own or glued straight after a sentence: "use canvasRead to…"
// in the middle of prose is someone asking about it and stays.
const known = new Set<string>();
let trailingName: RegExp | undefined;

/** Called with each turn's tool names; only camelCase ones can be stripped. */
export function noteToolNames(names: Iterable<string>): void {
  for (const name of names) {
    if (/^[a-z]+[A-Z][A-Za-z]*$/.test(name) && !known.has(name)) {
      known.add(name);
      trailingName = undefined;
    }
  }
}

noteToolNames(FAMILY_OF.keys());

export function stripLeakedToolName(text: string): string {
  trailingName ??= new RegExp(
    `(?:^|\\n|(?<=[.!?:)\\]]))[ \\t]*\`?(?:${[...known].join('|')})\`?\\s*$`
  );
  return text.replace(trailingName, '');
}
