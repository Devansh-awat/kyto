/**
 * What one model call did, step by step: how long each request took, how much
 * it thought and wrote, and how fast (owner's ask 2026-10-17, for choosing
 * between haiku and luna and their efforts). Tokens AND characters AND words,
 * because the two models' tokenizers differ: a haiku token is not a luna
 * token, so tokens alone can't compare them.
 *
 * Timestamps come from the stream's chunks; amounts from the finished
 * response's content and usage. A call that isn't streamed (generateText) has
 * no chunk timestamps, so its think and answer times are left out rather than
 * guessed.
 */

/** One step: one request to the model and its response. */
export interface StepStats {
  /** Request out → response done. */
  ms: number;
  outputTokens: number;
  reasoningChars: number;
  /** First → last streamed thinking chunk; absent when nothing streamed. */
  reasoningStreamMs?: number;
  reasoningTokens: number;
  reasoningWords: number;
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
  performance?: { responseTimeMs?: number; timeToFirstOutputMs?: number };
  usage: {
    outputTokenDetails?: { reasoningTokens?: number; textTokens?: number };
    outputTokens?: number;
  };
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
  let firstReasoningAt: number | undefined;
  let lastReasoningAt: number | undefined;
  let firstAnswerAt: number | undefined;
  return {
    onStart(): void {
      startedAt = now();
      firstOutputAt = undefined;
      firstReasoningAt = undefined;
      lastReasoningAt = undefined;
      firstAnswerAt = undefined;
    },
    onChunk(type: string): void {
      if (startedAt === undefined) {
        return;
      }
      const at = now();
      if (type === 'reasoning-delta') {
        firstOutputAt ??= at;
        firstReasoningAt ??= at;
        lastReasoningAt = at;
      } else if (ANSWER_CHUNKS.has(type)) {
        firstOutputAt ??= at;
        firstAnswerAt ??= at;
      }
    },
    onEnd({ content, performance: timing, usage }: CallEnd): void {
      const endedAt = now();
      const begun = startedAt ?? endedAt;
      startedAt = undefined;
      let reasoning = '';
      let text = '';
      let toolInput = '';
      for (const part of content) {
        if (part.type === 'reasoning') {
          reasoning += part.text ?? '';
        } else if (part.type === 'text') {
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
      steps.push({
        ms: Math.round(timing?.responseTimeMs ?? endedAt - begun),
        outputTokens: usage.outputTokens ?? 0,
        reasoningChars: reasoning.length,
        ...(firstReasoningAt !== undefined &&
        lastReasoningAt !== undefined &&
        lastReasoningAt > firstReasoningAt
          ? {
              reasoningStreamMs: Math.round(lastReasoningAt - firstReasoningAt),
            }
          : {}),
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
        reasoningWords: words(reasoning),
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
