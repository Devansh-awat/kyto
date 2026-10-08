// Prompt-cache breakpoint placement — the pure decision half of prompt caching,
// in its own module so it can be tested without booting the provider/env layer
// (see agent.cache.test.ts). agent.ts calls addCacheControl once per outgoing
// request from its fetch wrapper.

// A 1-hour cache breakpoint. Anthropic (and OpenRouter's passthrough to it)
// accept `ttl: '1h'` to extend the default 5-minute ephemeral cache to an hour,
// so the big system+tools prefix stays cached across a thread's sporadic turns
// (not just within one multi-step loop). Providers without extended TTL ignore
// the field; a bare `{ type: 'ephemeral' }` would just fall back to 5 minutes.
const CACHE_CONTROL = { ttl: '1h', type: 'ephemeral' } as const;

// Attach the cache breakpoint to a message's last content block, converting a
// string body to the content-array form OpenRouter expects. Returns false (a
// no-op) when there is nothing to attach to — an empty string or empty content
// array — so a caller can fall back to the next message.
function markCacheBreakpoint(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) {
      return false;
    }
    message.content = [
      { cache_control: CACHE_CONTROL, text: content, type: 'text' },
    ];
    return true;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content.at(-1);
    if (last && typeof last === 'object') {
      (last as Record<string, unknown>).cache_control = CACHE_CONTROL;
      return true;
    }
  }
  return false;
}

// Three breakpoints:
//
//  A — the FIRST system message: the static prompt that is byte-identical in
//      every thread (core, personality, sandbox, Slack). The per-thread facts
//      and the memory list ride in a SECOND system message after it, so a new
//      thread's first step still reads A instead of paying for all of it.
//  H — the last message of the replayed thread history, when the caller says
//      how many there are. OpenAI's newer models (gpt-6-luna) only look a cache
//      up at message endings and breakpoints, never at an arbitrary prefix:
//      with the history and the per-turn tail in ONE user message, the only
//      boundary two turns shared was the end of the system prompt, and every
//      turn re-wrote the whole thread at 1.25x (measured 2026-10-08: the same
//      15,507 tokens read on every turn of a thread, whatever its length).
//      With one message per Slack message and H on the newest, next turn the
//      same boundary is still a message ending, and the thread up to it hits.
//  B — the LAST message, whatever its role: caches everything sent so far,
//      including the growing assistant-tool-call / tool-result tail.
//
// B used to be pinned to the last USER message, and that was the bug behind
// "the whole prompt re-bills every step". A multi-step tool loop appends only
// assistant/tool messages after the opening user messages — there is never a
// new user message to advance the breakpoint to, so from step ~3 the entire
// accumulated tool tail sat AFTER the breakpoint and was re-billed uncached on
// every step, growing each time. Marking the literal last message instead (the
// AI SDK's own addCacheControlToMessages pattern) moves the breakpoint forward
// each step, so only the newest tool output is uncached. Providers without
// explicit caching ignore the field. OpenAI and Anthropic allow 4 cache writes a
// request; three explicit plus OpenAI's implicit one fits.
export function addCacheControl(
  payload: Record<string, unknown>,
  { historyMessages = 0 }: { historyMessages?: number } = {}
): boolean {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  const all = messages as Record<string, unknown>[];
  let changed = false;
  const firstSystem = all.find((m) => m.role === 'system');
  if (firstSystem && markCacheBreakpoint(firstSystem)) {
    changed = true;
  }
  const firstTurn = all.findIndex((m) => m.role !== 'system');
  const historyEnd = all[firstTurn + historyMessages - 1];
  if (
    firstTurn >= 0 &&
    historyMessages > 0 &&
    historyEnd !== undefined &&
    markCacheBreakpoint(historyEnd)
  ) {
    changed = true;
  }
  // Breakpoint B: walk from the newest message toward the front and mark the
  // first one a breakpoint can actually attach to. A pure tool-call assistant
  // message (content null, args in tool_calls) has no content block, so
  // markCacheBreakpoint no-ops on it — skip to the message before it. Stop at
  // a system message (A covers the prefix up to there).
  for (const message of [...all].reverse()) {
    if (message.role === 'system') {
      break;
    }
    if (markCacheBreakpoint(message)) {
      changed = true;
      break;
    }
  }
  return changed;
}
