/**
 * Where an attempt's wall-clock time went, from the stream's own parts: how long
 * each step waited for the model's first output, how fast it then wrote, and
 * how much of the attempt was tools running rather than the model. "kyto is
 * slow" had no answer in the logs before this — only a turn's total duration.
 * Kevinton reads these lines back (threadLogs) to say WHERE a slow turn went.
 */
export interface StreamTiming {
  /** Per step: start of the step to the model's first output in it. */
  firstOutputMs: number[];
  /** Everything else: the model thinking and writing, plus our own overhead. */
  modelMs: number;
  /**
   * Output tokens per second of GENERATION (a step's first model output to
   * its last),
   * across steps that reported usage. Absent when no step did.
   */
  outputTokensPerSecond?: number;
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

/** The fields of a stream part the timer reads. */
export interface TimedPart {
  toolCallId?: string;
  toolName?: string;
  type: string;
  usage?: { outputTokens?: number };
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

export function createStreamTimer(now: () => number = Date.now) {
  const startedAt = now();
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
  const firstOutputMs: number[] = [];
  const toolStarts = new Map<string, { at: number; name: string }>();
  const tools: { ms: number; name: string }[] = [];

  return {
    observe(input: string | TimedPart): void {
      const part = typeof input === 'string' ? { type: input } : input;
      const { type } = part;
      const at = now();
      if (type === 'start-step') {
        stepStartedAt = at;
        stepFirstOutputAt = undefined;
        stepLastOutputAt = undefined;
        return;
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
        firstOutputMs.push(at - stepStartedAt);
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
        const tokens = part.usage?.outputTokens;
        const ms =
          stepFirstOutputAt === undefined || stepLastOutputAt === undefined
            ? 0
            : stepLastOutputAt - stepFirstOutputAt;
        // A step whose output arrived in one burst has no measurable speed.
        if (tokens && ms > 0) {
          generatedTokens += tokens;
          generatingMs += ms;
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
