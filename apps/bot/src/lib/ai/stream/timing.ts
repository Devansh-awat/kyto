/**
 * Where an attempt's wall-clock time went, from the stream's own parts: how long
 * each step waited for the model's first output, and how much of the attempt
 * was tools running rather than the model. "kyto is slow" had no answer in the
 * logs before this — only a turn's total duration.
 */
export interface StreamTiming {
  /** Per step: start of the step to the model's first output in it. */
  firstOutputMs: number[];
  /** Everything else: the model thinking and writing, plus our own overhead. */
  modelMs: number;
  steps: number;
  /** Wall time with at least one tool running (parallel calls counted once). */
  toolMs: number;
  /** Whole attempt, first part to last. */
  totalMs: number;
}

const FIRST_OUTPUT = new Set([
  'reasoning-delta',
  'text-delta',
  'tool-call',
  'tool-input-start',
]);

export function createStreamTimer(now: () => number = Date.now) {
  const startedAt = now();
  let stepStartedAt: number | undefined;
  let sawOutput = false;
  let running = 0;
  let toolsStartedAt = 0;
  let toolMs = 0;
  let steps = 0;
  const firstOutputMs: number[] = [];

  return {
    observe(type: string): void {
      const at = now();
      if (type === 'start-step') {
        stepStartedAt = at;
        sawOutput = false;
        return;
      }
      if (!sawOutput && stepStartedAt !== undefined && FIRST_OUTPUT.has(type)) {
        sawOutput = true;
        firstOutputMs.push(at - stepStartedAt);
      }
      if (type === 'tool-call') {
        running += 1;
        if (running === 1) {
          toolsStartedAt = at;
        }
      } else if (
        (type === 'tool-result' || type === 'tool-error') &&
        running > 0
      ) {
        running -= 1;
        if (running === 0) {
          toolMs += at - toolsStartedAt;
        }
      } else if (type === 'finish-step') {
        steps += 1;
      }
    },
    summary(): StreamTiming {
      const end = now();
      const tools = toolMs + (running > 0 ? end - toolsStartedAt : 0);
      const totalMs = end - startedAt;
      return {
        firstOutputMs,
        modelMs: totalMs - tools,
        steps,
        toolMs: tools,
        totalMs,
      };
    },
  };
}
