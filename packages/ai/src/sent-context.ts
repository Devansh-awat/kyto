import type { ModelMessage } from 'ai';

/**
 * One request exactly as it went to the model: what a fallback model is handed
 * so it carries on from the same place, instead of a rebuilt approximation.
 * Rebuilding from the turn's tool results resurrected everything the failed
 * model's own compaction had already summarized away — 190k tokens became one
 * 901k request on the fallback (2026-10-27).
 */
export interface SentContext {
  /**
   * The provider-measured input of the request before this one, when this one
   * is that request plus what its step appended; absent after a compaction
   * (the context was just rewritten, so no measured size describes it).
   */
  inputTokens?: number;
  /** How many leading messages `inputTokens` covers. */
  measuredLength: number;
  messages: ModelMessage[];
  /** Where the task's request sits in `messages`; -1 when it isn't there. */
  requestIndex: number;
}

// A replayed call needs an id the next provider accepts as one it may not have
// issued: Gemini lets a `carried-` call through its signature check (agent.ts).
const CARRIED_PREFIX = 'carried-';

function carriedId(id: string): string {
  return id.startsWith(CARRIED_PREFIX) ? id : `${CARRIED_PREFIX}${id}`;
}

/**
 * The sent messages as another model can take them: the request swapped for
 * this attempt's own (it names the model writing the reply), reasoning parts
 * and provider metadata dropped (they are signed per provider and refused by
 * any other), call ids re-prefixed, and calls to a tool this attempt doesn't
 * have dropped with their results (a provider refuses an undefined tool).
 * Everything else — text, tool calls, results, images, a compaction summary —
 * goes over unchanged.
 */
export function replayableContext({
  context,
  request,
  toolNames,
}: {
  context: SentContext;
  request: ModelMessage;
  toolNames: ReadonlySet<string>;
}): { messages: ModelMessage[]; requestIndex: number; unmeasuredFrom: number } {
  const messages: ModelMessage[] = [];
  let requestIndex = -1;
  let unmeasuredFrom = 0;
  for (const [index, message] of context.messages.entries()) {
    if (index === context.measuredLength) {
      unmeasuredFrom = messages.length;
    }
    if (index === context.requestIndex) {
      requestIndex = messages.length;
      messages.push(request);
      continue;
    }
    const portable = portableMessage({ message, toolNames });
    if (portable) {
      messages.push(portable);
    }
  }
  if (context.measuredLength >= context.messages.length) {
    unmeasuredFrom = messages.length;
  }
  if (requestIndex === -1) {
    // Never sent without its request; put it after a leading summary.
    requestIndex = Math.min(1, messages.length);
    messages.splice(requestIndex, 0, request);
  }
  return { messages, requestIndex, unmeasuredFrom };
}

function portableMessage({
  message,
  toolNames,
}: {
  message: ModelMessage;
  toolNames: ReadonlySet<string>;
}): ModelMessage | undefined {
  if (typeof message.content === 'string') {
    return { ...message, providerOptions: undefined };
  }
  const content: unknown[] = [];
  for (const part of message.content) {
    if (part.type === 'reasoning' || part.type === 'reasoning-file') {
      continue;
    }
    const plain =
      'providerOptions' in part
        ? { ...part, providerOptions: undefined }
        : part;
    if (part.type === 'tool-call' || part.type === 'tool-result') {
      if (toolNames.has(part.toolName)) {
        content.push({ ...plain, toolCallId: carriedId(part.toolCallId) });
      }
      continue;
    }
    content.push(plain);
  }
  if (content.length === 0) {
    return;
  }
  return { ...message, content, providerOptions: undefined } as ModelMessage;
}
