import { z } from 'zod';
import { stepsCacheWrites } from './usage-cost';

/**
 * What one model call did, step by step: how long each request took, how much
 * it thought and wrote, and how fast (owner's ask 2026-10-17, for choosing
 * between haiku and luna and their efforts). The ANSWER is counted in tokens
 * AND characters AND words, because the two models' tokenizers differ: a haiku
 * token is not a luna token. Thinking only in tokens and time: neither model
 * shows its real thinking, only a summary another model writes, so its
 * characters measure the summary (owner's call 2026-10-17: don't log them).
 *
 * Timestamps come from the stream's chunks; amounts from the finished
 * response's content and usage. A call that isn't streamed (generateText) has
 * no chunk timestamps, so its think and answer times are left out rather than
 * guessed. A request that never finished (an error, a stall, a stop) is a
 * step too, with what was measured before it died, so failures count
 * against the model instead of vanishing from the stats.
 */

/** One step: one request to the model and its response. */
export interface StepStats {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `name status` of what killed a failed request, never its message. */
  error?: string;
  /**
   * The provider's (`stop`, `tool-calls`, `length` = hit the output cap,
   * `content-filter`, `error`, `other`), or ours for a request that never
   * finished: `error`, or `aborted` (a stop, the watchdog, an interrupt).
   */
  finishReason: string;
  /** All of it, cached or not. */
  inputTokens: number;
  /** Request out → response done (or → the failure). */
  ms: number;
  outputTokens: number;
  reasoningTokens: number;
  textChars: number;
  textTokens: number;
  textWords: number;
  /**
   * Request out → the first chunk of the ANSWER (reply text or a tool call):
   * prefill plus thinking, shown or hidden, so luna (which hides it) and haiku
   * compare. Absent when the step wrote no answer or wasn't streamed.
   */
  thinkMs?: number;
  toolInputChars: number;
  toolInputWords: number;
  /** Request out → first output chunk of any kind. */
  ttftMs?: number;
}

export interface CallStats {
  steps: StepStats[];
}

interface CallEnd {
  content: readonly { input?: unknown; text?: string; type: string }[];
  finishReason?: string;
  performance?: { responseTimeMs?: number; timeToFirstOutputMs?: number };
  usage: {
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    inputTokens?: number;
    outputTokenDetails?: { reasoningTokens?: number; textTokens?: number };
    outputTokens?: number;
    raw?: unknown;
  };
}

const errorShape = z.object({
  name: z.string().optional(),
  statusCode: z.number().optional(),
});

// The name and HTTP status only: an error's message can quote the prompt.
function errorLabel(error: unknown): string {
  const { name, statusCode } = errorShape.safeParse(error).data ?? {};
  return [name, statusCode].filter(Boolean).join(' ') || 'unknown';
}

function words(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

const ANSWER_CHUNKS = new Set(['text-delta', 'tool-input-start', 'tool-call']);

export function createCallMeter({
  now = () => performance.now(),
}: {
  now?: () => number;
} = {}) {
  const steps: StepStats[] = [];
  let startedAt: number | undefined;
  let firstOutputAt: number | undefined;
  let firstAnswerAt: number | undefined;
  let lastError: string | undefined;
  const failed = (finishReason: 'aborted' | 'error'): void => {
    if (startedAt === undefined) {
      return;
    }
    const endedAt = now();
    steps.push({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...(lastError ? { error: lastError } : {}),
      finishReason,
      inputTokens: 0,
      ms: Math.round(endedAt - startedAt),
      outputTokens: 0,
      reasoningTokens: 0,
      textChars: 0,
      textTokens: 0,
      textWords: 0,
      ...(firstAnswerAt === undefined
        ? {}
        : { thinkMs: Math.round(firstAnswerAt - startedAt) }),
      toolInputChars: 0,
      toolInputWords: 0,
      ...(firstOutputAt === undefined
        ? {}
        : { ttftMs: Math.round(firstOutputAt - startedAt) }),
    });
    startedAt = undefined;
  };
  return {
    /**
     * The call is over: a request still open never finished, so it is
     * recorded as failed. Call before `summary()` on every way out.
     */
    close(finishReason: 'aborted' | 'error'): void {
      failed(finishReason);
    },
    onError(error: unknown): void {
      lastError = errorLabel(error);
    },
    onStart(): void {
      // A request opened while the last is still open: the last one died.
      failed('error');
      lastError = undefined;
      startedAt = now();
      firstOutputAt = undefined;
      firstAnswerAt = undefined;
    },
    onChunk(type: string): void {
      if (startedAt === undefined) {
        return;
      }
      const at = now();
      if (type === 'reasoning-delta') {
        firstOutputAt ??= at;
      } else if (ANSWER_CHUNKS.has(type)) {
        firstOutputAt ??= at;
        firstAnswerAt ??= at;
      }
    },
    onEnd({
      content,
      finishReason,
      performance: timing,
      usage,
    }: CallEnd): void {
      const endedAt = now();
      const begun = startedAt ?? endedAt;
      startedAt = undefined;
      let text = '';
      let toolInput = '';
      for (const part of content) {
        if (part.type === 'text') {
          text += part.text ?? '';
        } else if (part.type === 'tool-call') {
          toolInput +=
            typeof part.input === 'string'
              ? part.input
              : JSON.stringify(part.input ?? {});
        }
      }
      const ttft =
        firstOutputAt === undefined
          ? timing?.timeToFirstOutputMs
          : firstOutputAt - begun;
      const reason = finishReason ?? 'other';
      steps.push({
        cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        // The gateway reports writes only in its raw usage (usage-cost.ts).
        cacheWriteTokens:
          stepsCacheWrites([{ usage }])[0] ||
          (usage.inputTokenDetails?.cacheWriteTokens ?? 0),
        ...(reason === 'error' && lastError ? { error: lastError } : {}),
        finishReason: reason,
        inputTokens: usage.inputTokens ?? 0,
        ms: Math.round(timing?.responseTimeMs ?? endedAt - begun),
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
        ...(firstAnswerAt === undefined
          ? {}
          : { thinkMs: Math.round(firstAnswerAt - begun) }),
        textChars: text.length,
        textTokens: usage.outputTokenDetails?.textTokens ?? 0,
        textWords: words(text),
        toolInputChars: toolInput.length,
        toolInputWords: words(toolInput),
        ...(ttft === undefined ? {} : { ttftMs: Math.round(ttft) }),
      });
    },
    summary(): CallStats | undefined {
      return steps.length > 0 ? { steps: [...steps] } : undefined;
    },
  };
}
