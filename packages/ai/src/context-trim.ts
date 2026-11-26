import type { ModelMessage } from 'ai';
import { PRIMARY_MODEL } from './providers/attempts';

// Compact once a step's ACTUAL input (the provider's count, not an estimate)
// passes 92% of the step (owner's call 2026-10-12): the model itself summarizes
// everything but the system prompt and tools. The summary request is the last
// request plus one instruction, so its whole prefix is a cache READ; after it
// the prompt is rewritten once from the summary on, then read again.
export const COMPACT_AT = 0.92;

// DeepSeek V4.1 Flash has no price step (one flat rate over 1M), so its entry
// is a size ceiling instead: compaction fires once a step's input passes
// 300k tokens (owner's call 2026-11-26), i.e. COMPACT_AT of this number.
// Haiku 5.5 (100k) and Luna (272k) once had real price steps here.
export const LONG_CONTEXT_PRICE_STEP: Record<string, number> = {
  [PRIMARY_MODEL]: Math.ceil(300_000 / COMPACT_AT),
};
// A compaction that leaves the next request above this share of the step bought
// too little room to be worth repeating, and the call compacts no more: one
// summarized 106k to 106k before each of 14 steps (2026-11-22).
export const COMPACT_HELPED_AT = 0.8;
// The fallback when the summary fails: fold old tool results down to this.
export const TRIM_TARGET = 0.55;

export const COMPACT_INSTRUCTION =
  '[Context compaction] This conversation is about to be replaced by your summary of it, to keep the request small. Summarize EVERYTHING above except the system prompt: the thread so far and all the work done in this task. Keep: what was asked and by whom, decisions and standing instructions (word for word, with who gave them), facts, names, ids, URLs, file paths, numbers, commands run and what they showed, errors and why they happened, what is done and what is left to do. Only the latest request is kept verbatim after the summary — your tool calls and their results are NOT, including the most recent ones, so give what the latest results showed in full detail. Write the summary only — do not call any tool.';

export type CompactionEvent =
  | { before: number; phase: 'start'; step: number }
  | {
      before: number;
      /** Estimated; `measured` follows with the real figure. */
      estimatedAfter: number;
      phase: 'done';
      step: number;
      /** False → the summary failed and old tool results were cut instead. */
      summarized: boolean;
    }
  | {
      after: number;
      before: number;
      phase: 'measured';
      step: number;
      /** It did not help enough, so this call will not compact again. */
      stopped: boolean;
    };

/**
 * The messages after compaction: the summary, then the request that started
 * this task. Nothing else survives, not even the last step: kept verbatim it
 * could be arbitrarily large (a fallback's carried tool rounds), and the
 * summary already covers it. `request` is the caller's short form of it (see
 * streamAttempt's `compactedPrompt`): the full one carries what earlier turns
 * thought and found, which kept 42k tokens through every compaction.
 */
export function compactedMessages({
  request,
  summary,
}: {
  request: ModelMessage;
  summary: string;
}): ModelMessage[] {
  return [
    {
      content: `<compacted_context>\nEverything before this point (the thread and the work so far, including your latest tool results) was compacted into this summary to save tokens. Run a tool again if you need exact output.\n\n${summary}\n</compacted_context>`,
      role: 'user',
    },
    request,
  ];
}

// Conservative (few chars per token) so an estimate errs toward trimming early.
const CHARS_PER_TOKEN = 3;
// A rough per-image token cost; the base64 length says nothing about it.
const IMAGE_TOKENS = 1600;
// A result smaller than this saves too little to be worth losing.
const MIN_TRIM_CHARS = 2000;
const KEPT_HEAD_CHARS = 500;
const TRIMMED_MARK = '[Trimmed:';

function partChars(part: unknown): number {
  if (typeof part !== 'object' || part === null || !('type' in part)) {
    return 0;
  }
  if (part.type === 'image' || part.type === 'file') {
    return IMAGE_TOKENS * CHARS_PER_TOKEN;
  }
  if ('text' in part && typeof part.text === 'string') {
    return part.text.length;
  }
  if (part.type === 'tool-call' && 'input' in part) {
    return JSON.stringify(part.input ?? null).length;
  }
  if (part.type === 'tool-result' && 'output' in part) {
    return outputText(part.output).length;
  }
  return 0;
}

/** A tool result's output as the text the model would read. */
function outputText(output: unknown): string {
  if (typeof output !== 'object' || output === null || !('type' in output)) {
    return '';
  }
  if (!('value' in output)) {
    return '';
  }
  return typeof output.value === 'string'
    ? output.value
    : JSON.stringify(output.value ?? null);
}

/** Estimated tokens the given messages add to a request. */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
      continue;
    }
    for (const part of message.content) {
      chars += partChars(part);
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface TrimPick {
  /** Index of the `tool` message holding it. */
  index: number;
  text: string;
  toolCallId: string;
  toolName: string;
}

/**
 * This turn's tool results to fold, OLDEST first, until the request is
 * estimated at or under `target` tokens. Only messages from `fromIndex` on are
 * considered — everything before it is the cached thread history. A result
 * already folded, or too small to be worth losing, is never picked, so a later
 * pass leaves earlier folds byte-identical (the cache reads them).
 *
 */
export function planTrim({
  fromIndex,
  messages,
  target,
  tokens,
}: {
  fromIndex: number;
  messages: ModelMessage[];
  target: number;
  tokens: number;
}): { picks: TrimPick[]; tokens: number } {
  let estimate = tokens;
  const picks: TrimPick[] = [];
  for (let index = fromIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (estimate <= target) {
        return { picks, tokens: estimate };
      }
      if (part.type !== 'tool-result') {
        continue;
      }
      const text = outputText(part.output);
      if (text.length < MIN_TRIM_CHARS || text.startsWith(TRIMMED_MARK)) {
        continue;
      }
      picks.push({
        index,
        text,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      });
      estimate -= Math.floor(text.length / CHARS_PER_TOKEN);
    }
  }
  return { picks, tokens: estimate };
}

/**
 * Cut the picked results to their first lines — the fallback when the summary
 * could not be written, so the request still shrinks.
 */
export function applyTrim({
  messages,
  picks,
}: {
  messages: ModelMessage[];
  picks: TrimPick[];
}): ModelMessage[] {
  if (picks.length === 0) {
    return messages;
  }
  const replacement = new Map(
    picks.map(
      (pick) =>
        [
          pick.toolCallId,
          `${TRIMMED_MARK} this ${pick.toolName} result (${pick.text.length} chars) was cut to keep the request small. It began: ${pick.text.slice(0, KEPT_HEAD_CHARS)}… Run the tool again if you need the rest.]`,
        ] as const
    )
  );
  const indexes = new Set(picks.map((pick) => pick.index));
  return messages.map((message, index) => {
    if (!indexes.has(index) || message.role !== 'tool') {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) => {
        const value =
          part.type === 'tool-result'
            ? replacement.get(part.toolCallId)
            : undefined;
        return value === undefined
          ? part
          : { ...part, output: { type: 'text' as const, value } };
      }),
    };
  });
}
