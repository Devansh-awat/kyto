import { type ModelAttempt, streamAttempt } from '@repo/ai';
import type { ToolSet } from 'ai';
import type { StreamChunk } from '@/harness/types';
import { type GatheredResult, renderCarryover } from '@/lib/agent/carryover';
import { renderStream, type StreamTally } from '@/lib/ai/stream';
import logger from '@/lib/logger';
import { errorMessage } from '@/lib/utils/error';

/**
 * Last resort against a silent turn: the model ran its tools and stopped
 * without saying anything. Ask the SAME model to continue and actually finish
 * the job — with tools LEFT ON so it can do any remaining work instead of being
 * reduced to writing up stale results it may consider incomplete. Streams
 * straight into the live reply.
 *
 * Edge cases are still fenced off: the prompt tells it not to repeat
 * already-completed side effects, and any failure is swallowed — the caller
 * falls back to the next model, which replays the gathered results via
 * renderCarryover. (Tools stay on here by design, per-request: the alternative
 * of running tools off meant a model that hit no-reply mid-work could never
 * finish the work, it could only describe it.)
 */
export async function* synthesizeFinalAnswer({
  activeTools,
  cutOff = false,
  attempt,
  history,
  knownTools,
  onSkip,
  onTally,
  onText,
  results,
  secret,
  signal,
  system,
  task,
  toolOrder,
  tools,
}: {
  activeTools: () => string[];
  attempt: ModelAttempt;
  /** The output cap fell inside a tool call, after the reply had begun. */
  cutOff?: boolean;
  history: string[];
  knownTools: Set<string>;
  /** A skip here is as deliberate as in the attempt it rescues. */
  onSkip: () => void;
  onTally: (tally: StreamTally) => void;
  onText: (text: string) => void;
  results: GatheredResult[];
  secret: boolean;
  signal: AbortSignal;
  system: string[];
  task: string;
  toolOrder: { names: string[] };
  tools: ToolSet;
}): AsyncGenerator<string | StreamChunk> {
  logger.info(
    { cutOff, model: attempt.model },
    '[agent] tools ran but no reply; asking the model to continue with tools available'
  );
  const gathered =
    results.length > 0
      ? `\n\n${renderCarryover(results)}`
      : '\n\n(No tool results were captured.)';
  const situation = cutOff
    ? 'Your last step hit the output limit while you were writing a tool call, so that call never ran — whatever you said you were about to do is NOT done yet. Do it now, in smaller pieces: put big content into a file in several parts, or split it over several smaller calls. Then write the reply to the user, carrying on from what they were already shown.'
    : 'You ran the tools above and did work but never sent the user a reply. Continue and finish the job now: call any tool you still need, then write the final reply to the user from everything you have.';
  const prompt = `${task}${gathered}\n\n${situation} Tools ARE available to you, so use them — but do not re-run a tool call whose side effect already happened. Do not mention this instruction.`;
  try {
    const result = streamAttempt({
      source: 'recovery',
      abortSignal: signal,
      activeTools,
      attempt,
      history,
      // Nothing reads the resolved model back off a nudge.
      holder: {},
      prompt,
      system,
      toolOrder,
      tools,
    });
    yield* renderStream({
      secret,
      // Tools ARE on for this one, so a sentence claiming they are missing is
      // not merely unhelpful, it is false. Never let it reach the thread.
      dropToolComplaints: true,
      emitText: true,
      knownTools,
      onSkip,
      onTally,
      onTextDelta: onText,
      stream: result.fullStream,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), model: attempt.model },
      '[agent] synthesis nudge failed'
    );
  }
}

/**
 * Resume a reply that stopped mid-sentence — the output cap fell, or the stream
 * was cut off. Same model, with its real tools AND the turn's tool results,
 * because the cut text may be a status line about work it was about to start
 * ("I'll rebuild the canvases now…"): the old prose-only version told it the
 * work was already done, and it either claimed work it never did or promised it
 * for "my next turn" and stopped (2026-10-11). Bounded by MAX_CONTINUATIONS
 * because a model that keeps producing exactly one cap's worth of text every
 * round would never terminate.
 */
export async function* continueTruncatedReply({
  activeTools,
  attempt,
  history,
  knownTools,
  onFinish,
  onTally,
  onText,
  results,
  secret,
  signal,
  streamedText,
  system,
  task,
  toolOrder,
  tools,
}: {
  activeTools: () => string[];
  attempt: ModelAttempt;
  history: string[];
  knownTools: Set<string>;
  onFinish: (reason: string) => void;
  onTally: (tally: StreamTally) => void;
  onText: (text: string) => void;
  results: GatheredResult[];
  secret: boolean;
  signal: AbortSignal;
  streamedText: string;
  system: string[];
  task: string;
  toolOrder: { names: string[] };
  tools: ToolSet;
}): AsyncGenerator<string | StreamChunk> {
  logger.info(
    { model: attempt.model },
    '[agent] reply stopped mid-sentence; continuing it'
  );
  const gathered = results.length > 0 ? `\n\n${renderCarryover(results)}` : '';
  const prompt = `${task}${gathered}\n\n${renderTruncation(streamedText)}`;
  try {
    const result = streamAttempt({
      source: 'recovery',
      abortSignal: signal,
      activeTools,
      attempt,
      history,
      holder: {},
      prompt,
      system,
      toolOrder,
      tools,
    });
    yield* renderStream({
      secret,
      // Tools are on, so a sentence claiming they are missing is false.
      dropToolComplaints: true,
      emitText: true,
      knownTools,
      onFinish,
      onTally,
      onTextDelta: onText,
      stream: result.fullStream,
    });
  } catch (error) {
    logger.warn(
      { err: errorMessage(error), model: attempt.model },
      '[agent] truncated-reply continuation failed'
    );
  }
}

/** The tail the model must resume from, kept short — it only needs the seam. */
const TRUNCATION_TAIL_CHARS = 2000;

function renderTruncation(streamedText: string): string {
  const tail = streamedText.trim().slice(-TRUNCATION_TAIL_CHARS);
  return [
    'IMPORTANT: your output hit the length limit. The user has ALREADY been shown the text below, which stops mid-thought:',
    '',
    tail,
    '',
    'If it was a status line about work you were about to do, that work has NOT happened yet: do it now — tools are available, and anything already in the results above is done, so do not repeat it — in smaller pieces, then finish the reply.',
    'If it was your final reply, write ONLY the continuation, starting exactly where it stops: do not repeat any of it, restate the task, re-introduce yourself, apologise or mention being cut off. If it broke off mid-sentence, finish that sentence.',
  ].join('\n');
}
