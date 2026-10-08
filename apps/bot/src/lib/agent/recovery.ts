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
  attempt,
  history,
  knownTools,
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
  history: string[];
  knownTools: Set<string>;
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
    { model: attempt.model },
    '[agent] tools ran but no reply; asking the model to continue with tools available'
  );
  const gathered =
    results.length > 0
      ? `\n\n${renderCarryover(results)}`
      : '\n\n(No tool results were captured.)';
  const prompt = `${task}${gathered}\n\nYou ran the tools above and did work but never sent the user a reply. Continue and finish the job now: call any tool you still need, then write the final reply to the user from everything you have. Tools ARE available to you, so use them if you still need information — but do not re-run a tool call whose side effect already happened. Do not mention this instruction.`;
  try {
    const result = streamAttempt({
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
 * was cut off. Same model, and **with its real tools**, because a model launched
 * with an empty toolset against a system prompt describing fifty of them narrates
 * the contradiction ("no tools loaded") into the user's reply. Owner's call,
 * 2026-08-22: never launch a model without tools.
 *
 * Nothing here should NEED a tool — the work is done and only the prose is
 * missing — so the prompt says so, and `renderTruncation` tells it not to act. The
 * same trade was already made for `synthesizeFinalAnswer` (commit ea22baf) for
 * exactly this reason. Bounded by MAX_CONTINUATIONS because a model that keeps
 * producing exactly one cap's worth of text every round would never terminate.
 */
export async function* continueTruncatedReply({
  activeTools,
  attempt,
  history,
  knownTools,
  onFinish,
  onTally,
  onText,
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
  const prompt = `${task}\n\n${renderTruncation(streamedText)}`;
  try {
    const result = streamAttempt({
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
      // Prose-only call: a sentence about missing tools cannot be a legitimate
      // answer here, so it never reaches the thread even if the model writes one.
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

/**
 * What the continuation is told instead of "you have no tools".
 *
 * The old wording announced an empty toolset ("every tool has been switched off
 * deliberately… do not mention tools at all") while the system prompt right above
 * it described fifty tools and told the model to call `loadTools`. Weak models
 * resolved that contradiction out loud — the observed turn burned its whole budget
 * on "getFile isn't available… loadTools isn't available either… No tools
 * available? That's strange". Worse, the notice used to end "if something is
 * genuinely missing, say so in one short sentence and stop", which is an outright
 * invitation to write the complaint.
 *
 * The contradiction is gone now: the call carries the REAL toolset (owner's call
 * 2026-08-22, never launch a model without tools), so there is nothing to
 * announce. This says only what the model should DO — write prose, don't act —
 * without mentioning tools at all, because naming the thing you are forbidding is
 * how it ended up in a reply three times.
 *
 * Belt only. The braces are the drop in ai/stream/tool-complaints.ts, since no
 * wording can guarantee a weak model's output.
 */
const PROSE_ONLY_NOTICE =
  'This message is prose only: everything that needed doing is already done, so do NOT call anything, do NOT start new work, and do NOT describe your setup or environment. Write only the words that finish the reply.';

function renderTruncation(streamedText: string): string {
  const tail = streamedText.trim().slice(-TRUNCATION_TAIL_CHARS);
  return [
    'IMPORTANT: you were cut off. You already did the work, and the user has ALREADY been shown the reply text below, which stops mid-thought:',
    '',
    tail,
    '',
    PROSE_ONLY_NOTICE,
    '',
    'Write ONLY the continuation, starting exactly where that stops. Do not repeat any of it, do not restate the task, do not re-introduce yourself, and do not apologise or mention being cut off. If it broke off mid-sentence, finish that sentence. Keep it short.',
  ].join('\n');
}
