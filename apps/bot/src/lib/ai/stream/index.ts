import type { TextStreamPart, ToolSet } from 'ai';
import type { StreamChunk } from '@/harness';
import logger from '@/lib/logger';
import { deepErrorText, errorStatus } from '@/lib/utils/error';
import { clamp } from '@/lib/utils/text';
import { renderTask } from './tasks';

const MAX_VISIBLE_TASKS = 45;
const REASONING_OUTPUT_MAX_LENGTH = 2800;
// How much of a provider error body to keep in the log. Enough to see the real
// upstream message (rate limit, context length, budget) without dumping a whole
// request body into the journal.
const ERROR_LOG_MAX_LENGTH = 800;

/**
 * What one model attempt's stream actually emitted. Logged at the end of every
 * attempt so a turn that went quiet can be explained from the journal alone:
 * zero text with tool calls is a silent completion, a non-empty `errors` with a
 * `tool-calls` last finish reason is a provider that died mid-task.
 */
export interface StreamTally {
  errors: string[];
  finishReasons: string[];
  reasoningParts: number;
  textChars: number;
  toolCalls: number;
  toolResults: number;
}

export interface StreamError {
  error: unknown;
  message: string;
  status?: number;
}

export async function* renderStream({
  context,
  emitText = false,
  knownTools,
  onTextDelta,
  onSkip,
  onToolActivity,
  onToolResult,
  onError,
  onFinish,
  onTally,
  stream,
}: {
  /** Attempt identity (model/provider/threadId) folded into every log line. */
  context?: Record<string, unknown>;
  /** Receives the attempt's tally once the stream ends (for the caller's log). */
  onTally?: (tally: StreamTally) => void;
  // When true, reply text is ALSO yielded as plain strings (the message body),
  // not only routed through onTextDelta. The main turn keeps this off (its text
  // is posted as separate messages via createReply); the subagent turns it on so
  // its streamed message shows the response in-body, alongside the plan cards.
  emitText?: boolean;
  knownTools?: ReadonlySet<string>;
  onTextDelta?: (text: string) => PromiseLike<void> | void;
  onSkip?: () => void;
  // Fires on the first real (non-phantom, registered) tool call. Lets the agent
  // loop tell "the model did actual work" apart from a truly empty completion,
  // so a turn that ran tools is never discarded as empty and restarted on a
  // fresh model (which would re-do all the work and burn the fallback chain).
  onToolActivity?: () => void;
  // Fires once per completed (non-phantom, non-skip) tool call with its input and
  // output. Lets the agent loop stash gathered results so that if a later step
  // truncates and the turn falls back to another model, those results can be
  // replayed into the fallback prompt — the new model answers from them instead
  // of re-running the same tools (e.g. re-doing identical web searches).
  onToolResult?: (info: {
    toolName: string;
    input: unknown;
    output: unknown;
  }) => void;
  // Fires for each stream-level error part (e.g. a provider 429 swallowed into
  // the stream). Lets the agent loop react to provider conditions — like a
  // HackClub "daily spending limit" 429, or a mid-task death that must not be
  // mistaken for a finished turn — that never surface as a thrown error.
  onError?: (info: StreamError) => void;
  // Fires for each stream finish/finish-step that carries a finishReason. Lets
  // the agent loop tell a deliberate completion (`stop`) apart from a truncated
  // or empty step that emitted no finish — the latter, when it also produced no
  // text, is the "stops mid-task" bug (tools ran, synthesis step came back empty)
  // and must fall back instead of ending the turn silently.
  onFinish?: (finishReason: string) => void;
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
}): AsyncGenerator<string | StreamChunk> {
  const toolInputs = new Map<string, unknown>();
  // Weak models sometimes hallucinate a tool call to a non-existent tool (e.g.
  // a mangled name like " analemma"). The harness answers with a "Tool X not
  // found" tool-result and the model recovers on the next step — but we must not
  // surface that phantom call/result as a visible activity task. Track their ids
  // so the matching tool-result/tool-error is dropped too.
  const phantomToolCallIds = new Set<string>();
  const reasoning = new Map<string, string>();
  // Each reasoning block gets its OWN unique task id. Providers reuse the same
  // `part.id` (often "0") for the reasoning of every step, so keying the task on
  // it collapsed all thinking into ONE row that stayed pinned wherever it first
  // appeared — which is why the plan looked like "all thinking, then all tools"
  // even when the model genuinely thinks between tool calls. A per-block counter
  // gives each stretch of reasoning a distinct row that lands in stream order,
  // so the plan reads thinking → tool → thinking → tool. `openReasoning` maps the
  // provider's (possibly reused) part id to the unique task id while it's open.
  let reasoningCounter = 0;
  const openReasoning = new Map<string, string>();
  const visibleTaskIds = new Set<string>();
  let hiddenTaskCount = 0;
  let skipped = false;
  let droppedTextDeltas = 0;
  // What this attempt emitted, so the caller can log why a turn ended the way it
  // did (silent completion vs. provider death mid-task) without a transcript.
  const tally: StreamTally = {
    errors: [],
    finishReasons: [],
    reasoningParts: 0,
    textChars: 0,
    toolCalls: 0,
    toolResults: 0,
  };
  for await (const part of stream) {
    if (part.type === 'finish-step' || part.type === 'finish') {
      const reason = (part as { finishReason?: string }).finishReason;
      if (reason) {
        tally.finishReasons.push(reason);
        onFinish?.(reason);
      }
    }
    if (part.type === 'error') {
      const error = (part as { error?: unknown }).error;
      const message = clamp(deepErrorText(error), ERROR_LOG_MAX_LENGTH) ?? '';
      const status = errorStatus(error);
      tally.errors.push(message);
      logger.error(
        { ...context, err: message, status },
        '[stream] provider error mid-stream'
      );
      onError?.({ error, message, status });
    }
    switch (part.type) {
      case 'text-delta': {
        // A skipped turn intentionally produces no reply, and some providers
        // emit placeholder garbage (e.g. "(Empty response: ...)") in this slot
        // when the model returned only a thinking block — never forward either.
        if (part.text && !skipped && !isPlaceholderText(part.text)) {
          tally.textChars += part.text.length;
          await onTextDelta?.(part.text);
          if (emitText) {
            yield part.text;
          }
        } else if (part.text) {
          droppedTextDeltas += 1;
        }
        break;
      }
      case 'reasoning-start': {
        tally.reasoningParts += 1;
        // A fresh unique row per reasoning block, so consecutive stretches of
        // thinking don't collapse onto one another (providers reuse part.id).
        const id = `reasoning-${reasoningCounter++}`;
        openReasoning.set(part.id, id);
        if (!showTask({ id, visibleTaskIds })) {
          hiddenTaskCount += 1;
          yield hiddenTaskUpdate({ count: hiddenTaskCount, done: false });
          break;
        }
        reasoning.set(id, '');
        yield {
          id,
          status: 'in_progress',
          title: 'Thinking',
          type: 'task_update',
        };
        break;
      }
      case 'reasoning-delta': {
        const id = openReasoning.get(part.id);
        if (id && visibleTaskIds.has(id)) {
          reasoning.set(id, (reasoning.get(id) ?? '') + part.text);
        }
        break;
      }
      case 'reasoning-end': {
        const id = openReasoning.get(part.id);
        openReasoning.delete(part.id);
        if (!(id && visibleTaskIds.has(id))) {
          break;
        }
        const text = reasoning.get(id)?.trim();
        yield {
          id,
          output: text ? clamp(text, REASONING_OUTPUT_MAX_LENGTH) : undefined,
          status: 'complete',
          title: 'Thinking',
          type: 'task_update',
        };
        reasoning.delete(id);
        break;
      }
      case 'tool-call': {
        // Drop hallucinated calls to tools we never registered: hide them from
        // the UI entirely (the model still gets the harness's not-found result
        // and recovers on the next step).
        if (knownTools && !knownTools.has(part.toolName.trim())) {
          phantomToolCallIds.add(part.toolCallId);
          logger.warn(
            { input: part.input, toolName: part.toolName },
            '[tool] ignored hallucinated tool call'
          );
          break;
        }
        toolInputs.set(part.toolCallId, part.input);
        tally.toolCalls += 1;
        onToolActivity?.();
        logger.info(
          {
            input: part.input,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
          },
          '[tool] called'
        );
        const rendered = renderTask({
          input: part.input,
          phase: 'request',
          toolName: part.toolName,
        });
        if (!showTask({ id: part.toolCallId, visibleTaskIds })) {
          hiddenTaskCount += 1;
          yield hiddenTaskUpdate({ count: hiddenTaskCount, done: false });
          break;
        }
        yield {
          details: rendered.details,
          id: part.toolCallId,
          status: 'in_progress',
          title: rendered.title,
          type: 'task_update',
        };
        break;
      }
      case 'tool-result': {
        if (phantomToolCallIds.has(part.toolCallId)) {
          phantomToolCallIds.delete(part.toolCallId);
          break;
        }
        tally.toolResults += 1;
        if (part.toolName === 'skip') {
          skipped = true;
          onSkip?.();
        } else {
          onToolResult?.({
            input: toolInputs.get(part.toolCallId),
            output: part.output,
            toolName: part.toolName,
          });
        }
        const input = toolInputs.get(part.toolCallId);
        logger.info(
          {
            input,
            output: part.output,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
          },
          '[tool] completed'
        );
        const rendered = renderTask({
          input,
          output: part.output,
          phase: 'response',
          toolName: part.toolName,
        });
        toolInputs.delete(part.toolCallId);
        if (!visibleTaskIds.has(part.toolCallId)) {
          break;
        }
        yield {
          id: part.toolCallId,
          output: rendered.output,
          status: 'complete',
          title: rendered.title,
          type: 'task_update',
        };
        break;
      }
      case 'tool-error': {
        if (phantomToolCallIds.has(part.toolCallId)) {
          phantomToolCallIds.delete(part.toolCallId);
          break;
        }
        const input = toolInputs.get(part.toolCallId);
        logger.warn(
          {
            error: part.error,
            input,
            toolCallId: part.toolCallId,
            toolName: part.toolName,
          },
          '[tool] failed'
        );
        const rendered = renderTask({
          input,
          output: part.error,
          phase: 'error',
          toolName: part.toolName,
        });
        toolInputs.delete(part.toolCallId);
        if (!visibleTaskIds.has(part.toolCallId)) {
          break;
        }
        yield {
          id: part.toolCallId,
          output: rendered.output,
          status: 'error',
          title: rendered.title,
          type: 'task_update',
        };
        break;
      }
      default:
        break;
    }
  }
  if (hiddenTaskCount > 0) {
    yield hiddenTaskUpdate({ count: hiddenTaskCount, done: true });
  }
  logger.info(
    { ...context, ...tally, droppedTextDeltas },
    '[stream] attempt stream ended'
  );
  onTally?.(tally);
}

// Some upstream proxies, when a model returns only a thinking block with no
// text, substitute a placeholder string (e.g. a Python-repr "(Empty response:
// {...})") into the text slot. Never surface those to users.
const PLACEHOLDER_TEXT = /^\s*\(empty (response|completion):/i;

function isPlaceholderText(text: string): boolean {
  return PLACEHOLDER_TEXT.test(text);
}

function showTask({
  id,
  visibleTaskIds,
}: {
  id: string;
  visibleTaskIds: Set<string>;
}): boolean {
  if (visibleTaskIds.has(id)) {
    return true;
  }
  if (visibleTaskIds.size < MAX_VISIBLE_TASKS) {
    visibleTaskIds.add(id);
    return true;
  }
  return false;
}

function hiddenTaskUpdate({
  count,
  done,
}: {
  count: number;
  done: boolean;
}): StreamChunk {
  return {
    id: 'hidden-activity',
    output: done
      ? `Ran ${count} additional activity item${count === 1 ? '' : 's'}.`
      : undefined,
    status: done ? 'complete' : 'in_progress',
    title: `Activity: ${count}`,
    type: 'task_update',
  };
}
