/**
 * Where an attempt's wall-clock time went, from the stream's own parts: how long
 * each step waited for the model's first output, how fast it then wrote, and
 * how much of the attempt was tools running rather than the model. "kyto is
 * slow" had no answer in the logs before this — only a turn's total duration.
 * Kevinton reads these lines back (threadLogs) to say WHERE a slow turn went.
 */
export interface StreamTiming {
  /**
   * Per step: the request going out (the attempt's start, then the previous
   * step's end) to the model's first output. The SDK only emits `start-step`
   * once the first chunk is in, so timing from it measured ~0ms every time.
   */
  firstOutputMs: number[];
  /** Everything else: the model thinking and writing, plus our own overhead. */
  modelMs: number;
  /**
   * Characters of reply text and tool-call arguments per second, from a step's
   * first such character to its last. Tokens/s can't compare models: haiku's
   * tokenizer spends more tokens on the same text than luna's, and output
   * tokens include reasoning that one model shows and the other hides.
   */
  outputCharsPerSecond?: number;
  /**
   * Output tokens per second of GENERATION (a step's first model output to
   * its last),
   * across steps that reported usage. Absent when no step did.
   */
  outputTokensPerSecond?: number;
  /**
   * One row per step: `[firstOutputMs, thinkMs, reasoningTokens,
   * reasoningChars, textChars, toolInputChars, outputTokens]`. Tuples, not
   * objects: a 40-step turn is one log line.
   */
  perStep: StepRow[];
  /** What the model thought, summed so a turn can add its attempts up. */
  reasoning: ReasoningCounts;
  steps: number;
  /** Wall time with at least one tool running (parallel calls counted once). */
  toolMs: number;
  /** The slowest tool calls, each from its call to its result. */
  tools: { ms: number; name: string }[];
  /** Whole attempt, first part to last. */
  totalMs: number;
  /** Time to first token: the attempt's start to the model's first output. */
  ttftMs?: number;
}

type StepRow = [
  firstOutputMs: number,
  thinkMs: number,
  reasoningTokens: number,
  reasoningChars: number,
  textChars: number,
  toolInputChars: number,
  outputTokens: number,
];

/**
 * Raw sums, so attempts and turns add up and the ratios are computed once
 * (describeReasoning). A thinking BLOCK is one reasoning-start..end; a
 * thinking STEP is a model request that reported reasoning tokens or text.
 */
export interface ReasoningCounts {
  blocks: number;
  /** Blocks whose whole text arrived in one delta: buffered, not streamed. */
  burstBlocks: number;
  chars: number;
  /** Longest single block, in characters. */
  maxBlockChars: number;
  /** Most reasoning tokens in one step. */
  maxStepTokens: number;
  outputTokens: number;
  steps: number;
  /** Steps that reported usage at all. */
  stepsWithUsage: number;
  /** Characters of reasoning in blocks that streamed (more than one delta). */
  streamedChars: number;
  /** First delta to `reasoning-end` of those blocks. */
  streamedMs: number;
  textChars: number;
  textTokens: number;
  thinkingSteps: number;
  /**
   * Request out to the first reply text or tool call, per step, summed:
   * prefill plus thinking, visible or not. The one thinking time that means
   * the same for a model that streams its reasoning and one that hides it.
   */
  thinkMs: number;
  /** Reasoning tokens the provider reported (hidden reasoning included). */
  tokens: number;
  toolInputChars: number;
}

export function emptyReasoningCounts(): ReasoningCounts {
  return {
    blocks: 0,
    burstBlocks: 0,
    chars: 0,
    maxBlockChars: 0,
    maxStepTokens: 0,
    outputTokens: 0,
    steps: 0,
    stepsWithUsage: 0,
    streamedChars: 0,
    streamedMs: 0,
    textChars: 0,
    textTokens: 0,
    thinkMs: 0,
    thinkingSteps: 0,
    tokens: 0,
    toolInputChars: 0,
  };
}

export function addReasoningCounts(
  into: ReasoningCounts,
  more: ReasoningCounts
): ReasoningCounts {
  return {
    blocks: into.blocks + more.blocks,
    burstBlocks: into.burstBlocks + more.burstBlocks,
    chars: into.chars + more.chars,
    maxBlockChars: Math.max(into.maxBlockChars, more.maxBlockChars),
    maxStepTokens: Math.max(into.maxStepTokens, more.maxStepTokens),
    outputTokens: into.outputTokens + more.outputTokens,
    steps: into.steps + more.steps,
    stepsWithUsage: into.stepsWithUsage + more.stepsWithUsage,
    streamedChars: into.streamedChars + more.streamedChars,
    streamedMs: into.streamedMs + more.streamedMs,
    textChars: into.textChars + more.textChars,
    textTokens: into.textTokens + more.textTokens,
    thinkMs: into.thinkMs + more.thinkMs,
    thinkingSteps: into.thinkingSteps + more.thinkingSteps,
    tokens: into.tokens + more.tokens,
    toolInputChars: into.toolInputChars + more.toolInputChars,
  };
}

const per = (a: number, b: number, scale = 1): number | undefined =>
  b > 0 ? Math.round((a * scale) / b) : undefined;
const ratio = (a: number, b: number): number | undefined =>
  b > 0 ? Math.round((a / b) * 100) / 100 : undefined;

/**
 * The ratios the effort experiment is judged on. `charsPerToken` near 4 means
 * the full reasoning was streamed; far below it means a summary (luna shows
 * one) or nothing, so `chars`-based numbers say nothing about that model.
 */
export function describeReasoning(counts: ReasoningCounts) {
  return {
    ...counts,
    charsPerBlock: per(counts.chars, counts.blocks),
    charsPerSecond: per(counts.streamedChars, counts.streamedMs, MS_PER_SECOND),
    charsPerToken: ratio(counts.chars, counts.tokens),
    msPerThinkingStep: per(counts.thinkMs, counts.thinkingSteps),
    reasoningShareOfOutput: ratio(counts.tokens, counts.outputTokens),
    tokensPerStep: per(counts.tokens, counts.stepsWithUsage),
    tokensPerThinkSecond: per(counts.tokens, counts.thinkMs, MS_PER_SECOND),
    tokensPerThinkingStep: per(counts.tokens, counts.thinkingSteps),
  };
}

/** The fields of a stream part the timer reads. */
export interface TimedPart {
  /** `tool-input-delta`'s text. */
  delta?: string;
  /** `reasoning-*`'s block id. */
  id?: string;
  /** `text-delta`'s and `reasoning-delta`'s text. */
  text?: string;
  toolCallId?: string;
  toolName?: string;
  type: string;
  usage?: {
    outputTokenDetails?: {
      reasoningTokens?: number;
      textTokens?: number;
    };
    outputTokens?: number;
  };
}

const FIRST_OUTPUT = new Set([
  'reasoning-delta',
  'text-delta',
  'tool-call',
  'tool-input-start',
]);
// Everything the MODEL streams. Generation speed is measured to the last of
// these in a step, not to the step's finish: tools run inside the step, and
// counting them would make a model look slow for waiting on opencode.
const MODEL_OUTPUT = new Set([
  ...FIRST_OUTPUT,
  'reasoning-end',
  'text-end',
  'tool-input-delta',
  'tool-input-end',
]);
const SLOWEST_TOOLS = 8;
const MS_PER_SECOND = 1000;
// A rate over a shorter window is a buffered burst, not a speed: a step that
// arrived in one lump logged 25,000 chars/s.
const MIN_RATE_WINDOW_MS = 500;
// What counts as the model starting its ANSWER (not its thinking) in a step.
const ANSWER_OUTPUT = new Set(['text-delta', 'tool-call', 'tool-input-start']);

export function createStreamTimer(now: () => number = Date.now) {
  const startedAt = now();
  // When the current step's request went out: see `firstOutputMs`.
  let requestAt = startedAt;
  let stepAnswerAt: number | undefined;
  let stepReasoningChars = 0;
  let stepTextChars = 0;
  let stepToolInputChars = 0;
  const reasoning = emptyReasoningCounts();
  const perStep: StepRow[] = [];
  // Open thinking blocks by provider id: first delta's time, chars, deltas.
  const blocks = new Map<
    string,
    { chars: number; deltas: number; firstAt?: number }
  >();
  const closeBlock = (id: string, at: number) => {
    const block = blocks.get(id);
    blocks.delete(id);
    if (!block) {
      return;
    }
    reasoning.blocks += 1;
    reasoning.maxBlockChars = Math.max(reasoning.maxBlockChars, block.chars);
    if (block.deltas <= 1) {
      reasoning.burstBlocks += block.chars > 0 ? 1 : 0;
    } else if (block.firstAt !== undefined && at > block.firstAt) {
      reasoning.streamedChars += block.chars;
      reasoning.streamedMs += at - block.firstAt;
    }
  };
  let stepStartedAt: number | undefined;
  let stepFirstOutputAt: number | undefined;
  let stepLastOutputAt: number | undefined;
  let firstOutputAt: number | undefined;
  let running = 0;
  let toolsStartedAt = 0;
  let toolMs = 0;
  let steps = 0;
  let generatedTokens = 0;
  let generatingMs = 0;
  let stepFirstCharAt: number | undefined;
  let stepLastCharAt: number | undefined;
  let stepChars = 0;
  let writtenChars = 0;
  let writingMs = 0;
  const firstOutputMs: number[] = [];
  const toolStarts = new Map<string, { at: number; name: string }>();
  const tools: { ms: number; name: string }[] = [];

  return {
    observe(input: string | TimedPart): void {
      const part = typeof input === 'string' ? { type: input } : input;
      const { type } = part;
      const at = now();
      if (type === 'start-step') {
        stepStartedAt = requestAt;
        stepAnswerAt = undefined;
        stepReasoningChars = 0;
        stepTextChars = 0;
        stepToolInputChars = 0;
        stepFirstOutputAt = undefined;
        stepLastOutputAt = undefined;
        stepFirstCharAt = undefined;
        stepLastCharAt = undefined;
        stepChars = 0;
        return;
      }
      if (type === 'reasoning-start') {
        blocks.set(part.id ?? '', { chars: 0, deltas: 0 });
      } else if (type === 'reasoning-delta') {
        const length = part.text?.length ?? 0;
        const block = blocks.get(part.id ?? '');
        if (block && length > 0) {
          block.chars += length;
          block.deltas += 1;
          block.firstAt ??= at;
        }
        reasoning.chars += length;
        stepReasoningChars += length;
      } else if (type === 'reasoning-end') {
        closeBlock(part.id ?? '', at);
      }
      if (stepAnswerAt === undefined && ANSWER_OUTPUT.has(type)) {
        stepAnswerAt = at;
      }
      let chars = 0;
      if (type === 'text-delta') {
        chars = part.text?.length ?? 0;
        stepTextChars += chars;
      } else if (type === 'tool-input-delta') {
        chars = part.delta?.length ?? 0;
        stepToolInputChars += chars;
      }
      if (chars > 0) {
        // The first delta's characters arrived before the window opened, so
        // only the ones after it are counted against it.
        if (stepFirstCharAt === undefined) {
          stepFirstCharAt = at;
        } else {
          stepChars += chars;
        }
        stepLastCharAt = at;
      }
      if (MODEL_OUTPUT.has(type)) {
        stepLastOutputAt = at;
      }
      if (
        stepFirstOutputAt === undefined &&
        stepStartedAt !== undefined &&
        FIRST_OUTPUT.has(type)
      ) {
        stepFirstOutputAt = at;
        firstOutputAt ??= at;
        firstOutputMs.push(at - requestAt);
      }
      if (type === 'tool-call') {
        running += 1;
        if (running === 1) {
          toolsStartedAt = at;
        }
        if (part.toolCallId) {
          toolStarts.set(part.toolCallId, {
            at,
            name: part.toolName ?? 'unknown',
          });
        }
      } else if (
        (type === 'tool-result' || type === 'tool-error') &&
        running > 0
      ) {
        running -= 1;
        if (running === 0) {
          toolMs += at - toolsStartedAt;
        }
        const started = part.toolCallId
          ? toolStarts.get(part.toolCallId)
          : undefined;
        if (started && part.toolCallId) {
          toolStarts.delete(part.toolCallId);
          tools.push({ ms: at - started.at, name: started.name });
        }
      } else if (type === 'finish-step') {
        steps += 1;
        for (const id of [...blocks.keys()]) {
          closeBlock(id, at);
        }
        const tokens = part.usage?.outputTokens;
        const reasoningTokens =
          part.usage?.outputTokenDetails?.reasoningTokens ?? 0;
        const thinkMs =
          stepAnswerAt === undefined ? 0 : stepAnswerAt - requestAt;
        reasoning.steps += 1;
        reasoning.textChars += stepTextChars;
        reasoning.toolInputChars += stepToolInputChars;
        if (tokens !== undefined) {
          reasoning.stepsWithUsage += 1;
          reasoning.outputTokens += tokens;
          reasoning.tokens += reasoningTokens;
          reasoning.textTokens +=
            part.usage?.outputTokenDetails?.textTokens ?? 0;
          reasoning.maxStepTokens = Math.max(
            reasoning.maxStepTokens,
            reasoningTokens
          );
        }
        if (reasoningTokens > 0 || stepReasoningChars > 0) {
          reasoning.thinkingSteps += 1;
          reasoning.thinkMs += thinkMs;
        }
        perStep.push([
          stepFirstOutputAt === undefined ? -1 : stepFirstOutputAt - requestAt,
          thinkMs,
          reasoningTokens,
          stepReasoningChars,
          stepTextChars,
          stepToolInputChars,
          tokens ?? 0,
        ]);
        // The next request goes out as this step ends.
        requestAt = at;
        const ms =
          stepFirstOutputAt === undefined || stepLastOutputAt === undefined
            ? 0
            : stepLastOutputAt - stepFirstOutputAt;
        // A step whose output arrived in one burst has no measurable speed.
        if (tokens && ms >= MIN_RATE_WINDOW_MS) {
          generatedTokens += tokens;
          generatingMs += ms;
        }
        if (
          stepFirstCharAt !== undefined &&
          stepLastCharAt !== undefined &&
          stepLastCharAt - stepFirstCharAt >= MIN_RATE_WINDOW_MS
        ) {
          writtenChars += stepChars;
          writingMs += stepLastCharAt - stepFirstCharAt;
        }
      }
    },
    summary(): StreamTiming {
      const end = now();
      const toolWallMs = toolMs + (running > 0 ? end - toolsStartedAt : 0);
      const totalMs = end - startedAt;
      // A call still running at the end is the likeliest culprit of a slow
      // attempt, so it is listed too, up to now.
      const all = [
        ...tools,
        ...[...toolStarts.values()].map(({ at, name }) => ({
          ms: end - at,
          name: `${name} (unfinished)`,
        })),
      ];
      return {
        firstOutputMs,
        modelMs: totalMs - toolWallMs,
        ...(generatedTokens > 0 && generatingMs > 0
          ? {
              outputTokensPerSecond: Math.round(
                (generatedTokens * MS_PER_SECOND) / generatingMs
              ),
            }
          : {}),
        ...(writtenChars > 0 && writingMs > 0
          ? {
              outputCharsPerSecond: Math.round(
                (writtenChars * MS_PER_SECOND) / writingMs
              ),
            }
          : {}),
        perStep,
        reasoning: { ...reasoning },
        steps,
        toolMs: toolWallMs,
        tools: all.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_TOOLS),
        totalMs,
        ...(firstOutputAt === undefined
          ? {}
          : { ttftMs: firstOutputAt - startedAt }),
      };
    },
  };
}
