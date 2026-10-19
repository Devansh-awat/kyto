import { FAMILY_OF } from '@/lib/ai/merge-tools';

// A model that drops the tool-call channel for a moment writes the NAME of the
// tool it meant to call into the reply: a turn's message ended in the literal
// text `canvasRead` (#123). The family actions are no longer registered under
// those names (`canvas` is), so the model is reaching for a name it was never
// handed — and nobody reading Slack should ever see one.
//
// Only a camelCase action name, and only at the very END of the text, on a line
// of its own or glued straight after a sentence: "use canvasRead to…" in the
// middle of prose is someone asking about it and stays.
const LEAKABLE = [...FAMILY_OF.keys()].filter((name) => /[A-Z]/.test(name));
const TRAILING_NAME = new RegExp(
  `(?:^|\\n|(?<=[.!?:)\\]]))[ \\t]*\`?(?:${LEAKABLE.join('|')})\`?\\s*$`
);

export function stripLeakedToolName(text: string): string {
  return text.replace(TRAILING_NAME, '');
}
