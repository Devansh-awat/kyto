import type { ModelMessage } from 'ai';

// Models whose whole request is billed at a higher rate once its input passes a
// size: Haiku 5.5 costs ~5x per token past 100k input tokens (owner, 2026-10-12).
// Measured 2026-10-11: 44 Haiku requests went past it, every one a LATER step of
// a tool-heavy turn — the replayed thread (step 0) peaked at 81k — so thread
// compaction could not have prevented any of them; tool results piling up
// inside one turn did it.
export const LONG_CONTEXT_PRICE_STEP: Record<string, number> = {
  'anthropic/claude-haiku-5.5': 100_000,
};

// Trim once the next request is estimated past 85% of the step, and then trim
// down to 55%. The gap is what keeps the cache hit rate up: a trim rewrites the
// prompt from the first trimmed result onward, so that tail is a cache WRITE
// once. Trimming a little every step would re-write it every step; trimming a
// lot rarely pays for one rewrite and then reads from cache again until the
// turn has grown by ~30% of the step. The 15% headroom absorbs the estimate's
// error (chars per token varies with content).
export const TRIM_TRIGGER = 0.85;
export const TRIM_TARGET = 0.55;

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
 * Same idea as Anthropic's own context editing (old tool results replaced by a
 * placeholder); a thinking block stays valid because only results change.
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
 * Replace the picked results. With a `summary`, the first carries it and the
 * rest point at it; without one (no summarizer, or it failed), each keeps its
 * own head so the model still knows roughly what it held.
 */
export function applyTrim({
  messages,
  picks,
  summary,
}: {
  messages: ModelMessage[];
  picks: TrimPick[];
  summary?: string;
}): ModelMessage[] {
  if (picks.length === 0) {
    return messages;
  }
  const first = picks[0];
  const stub = (pick: TrimPick): string => {
    if (!summary) {
      return `${TRIMMED_MARK} this ${pick.toolName} result (${pick.text.length} chars) was cut to keep the request small. It began: ${pick.text.slice(0, KEPT_HEAD_CHARS)}… Run the tool again if you need the rest.]`;
    }
    return pick === first
      ? `${TRIMMED_MARK} the ${picks.length} oldest tool results of this turn were compacted into this summary to keep the request small. Run a tool again if you need exact output.]\n${summary}`
      : `${TRIMMED_MARK} compacted into the summary in the ${first?.toolName} result above.]`;
  };
  const replacement = new Map(
    picks.map((pick) => [pick.toolCallId, stub(pick)] as const)
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
