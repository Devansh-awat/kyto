// Prompt-cache prefix probe — the pure, testable half of "did caching work".
//
// Prompt caching is a PREFIX match: a provider reuses the longest run of leading
// tokens identical to something it has already seen. So one changed byte early
// in a request throws away the entire cached prefix after it, and the ONLY
// symptom is the bill — the turn still succeeds, just at full price. That is
// exactly how a per-turn timestamp sat in the system prompt for weeks.
//
// This splits an outgoing request into the units a provider serializes in order
// (tool schemas first, then each message) and reports where the current request
// stops matching the previous one from the same attempt. The healthy shape is a
// pure APPEND: every earlier unit identical, only new assistant/tool messages on
// the end. Anything else is prefix churn and gets logged.

import { z } from 'zod';

export interface PrefixUnit {
  chars: number;
  hash: number;
  label: string;
}

export interface PrefixDivergence {
  // True when every unit of the previous request survived unchanged and the new
  // request only added to the end — the only shape that caches well.
  appendOnly: boolean;
  // Index of the first unit that differs, and what it is.
  index: number;
  label: string;
  // Characters that still matched before the divergence, out of the whole
  // request. stable/total is roughly the best cache hit rate this request can
  // possibly get.
  stableChars: number;
  totalChars: number;
}

// A plain polynomial rolling hash, kept to arithmetic (no bitwise ops, which
// the lint preset bans) and inside 2^53 so nothing silently loses precision.
// Not cryptographic and doesn't need to be: a collision would only under-report
// churn in a diagnostic, and we hash the length in too.
const HASH_MODULUS = 2_147_483_647;
const HASH_FACTOR = 131;

function hashString(value: string): number {
  let hash = value.length % HASH_MODULUS;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * HASH_FACTOR + value.charCodeAt(index)) % HASH_MODULUS;
  }
  return hash;
}

function unitOf(label: string, value: unknown): PrefixUnit {
  const text = JSON.stringify(value) ?? '';
  return { chars: text.length, hash: hashString(text), label };
}

const namedTool = z.union([
  z.object({ function: z.object({ name: z.string() }) }),
  z.object({ name: z.string() }),
]);

function toolName(item: unknown): string | undefined {
  const parsed = namedTool.safeParse(item).data;
  if (!parsed) {
    return;
  }
  return 'function' in parsed ? parsed.function.name : parsed.name;
}

/**
 * Split a chat-completions payload into ordered prefix units. Tools come first
 * because that is where providers put them in the rendered prompt — a tool
 * schema appearing mid-turn (which is what `loadTools` does) invalidates every
 * message after it, not just itself.
 *
 * Call this BEFORE addCacheControl: the moving breakpoint rewrites a message's
 * content shape each step, which would read as churn that isn't there.
 */
export function prefixUnits(payload: Record<string, unknown>): PrefixUnit[] {
  const units: PrefixUnit[] = [];
  // One unit per tool, so a divergence names the tool that changed: hashed as
  // one block, "tools(27) diverged" on most turns said nothing about which of
  // them differed from the last turn.
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  for (const [index, item] of tools.entries()) {
    units.push(unitOf(`tool:${toolName(item) ?? index}`, item));
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const [index, message] of messages.entries()) {
    const role =
      message && typeof message === 'object'
        ? String((message as Record<string, unknown>).role ?? 'unknown')
        : 'unknown';
    units.push(unitOf(`${index}:${role}`, message));
  }
  return units;
}

/**
 * Compare this request's units against the previous request of the same
 * attempt. Returns null for the first request (nothing to compare against).
 */
export function comparePrefix(
  previous: PrefixUnit[],
  next: PrefixUnit[]
): PrefixDivergence | null {
  if (previous.length === 0) {
    return null;
  }
  let index = 0;
  let stableChars = 0;
  while (index < previous.length && index < next.length) {
    const before = previous[index];
    const after = next[index];
    if (!(before && after) || before.hash !== after.hash) {
      break;
    }
    stableChars += after.chars;
    index++;
  }
  let totalChars = 0;
  for (const unit of next) {
    totalChars += unit.chars;
  }
  return {
    appendOnly: index === previous.length,
    index,
    label: next[index]?.label ?? '(end)',
    stableChars,
    totalChars,
  };
}
