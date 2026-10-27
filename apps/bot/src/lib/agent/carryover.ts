import type { JSONValue, ModelMessage } from 'ai';
import { redactSecrets } from '@/lib/email/redact';
import { clamp } from '@/lib/utils/text';

// What a fallback model is told about the work the previous attempt already did.
// Split out of the agent loop so the invariants have tests: these blocks are the
// entire reason a cross-model handoff continues a turn instead of restarting it,
// and their wording is load-bearing prompt text, not decoration.

export interface GatheredResult {
  input: unknown;
  output: unknown;
  toolName: string;
}

// Bounds on the replayed carryover so a fallback prompt can't blow up context
// (web-search results are large): keep the most recent results and clamp each.
export const CARRYOVER_MAX_RESULTS = 12;
export const CARRYOVER_OUTPUT_MAX = 1500;
const CARRYOVER_INPUT_MAX = 400;

// Bounds on the REAL-message carryover (`carriedMessages`). Its comment used to
// claim "whole — streamAttempt compacts the first request when it's too big",
// but that is false: the carried results become the first request's LAST STEP,
// which step-0 compaction keeps VERBATIM (compactedMessages in context-trim.ts),
// so it cannot shrink them. A 164-step attempt that fell back therefore shipped
// all 164 tool results, full output, as one 901k-token haiku step 0 billed at
// the 5x-over-100k rate — $0.87 in one request (2026-10-27). So bound it here:
// keep the most recent results whole, newest-first, until this char budget, and
// clamp any single result that alone exceeds the per-result cap. Older results
// are dropped (the thread and the thinking store still carry them); a note tells
// the model some were left out so it re-runs a tool if it needs the rest.
const CARRIED_TOTAL_MAX = 60_000;
const CARRIED_RESULT_MAX = 8000;

// Bounds on the tool calls and results persisted into the thinking store and
// replayed while the turn is one of the last three (owner's call 2026-10-16).
// Every call is kept, each result cut to OBSERVATION_OUTPUT_MAX, and the turn
// to OBSERVATION_TURN_MAX, most recent first: three tool-heavy turns must not
// push the next request past the long-context price step.
const EMAIL_RESULT = /^(?:email|checkInbox|readEmail|mcp_agentmail)/;
const OBSERVATION_OUTPUT_MAX = 6000;
const OBSERVATION_INPUT_MAX = 1000;
export const OBSERVATION_TURN_MAX = 30_000;
// One line per call for the thread digest (#2): what was done, not the data.
const ACTION_INPUT_MAX = 160;
const ACTION_OUTPUT_MAX = 160;
const ACTIONS_TURN_MAX = 3000;

/** A stable string for a tool input, used both for rendering and for dedupe. */
export function stableInput(input: unknown): string {
  try {
    return typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function toCompactText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : stableInput(value);
  return clamp(text, max) ?? text;
}

/**
 * Tell a fallback model that the turn is already IN PROGRESS in Slack: the
 * previous model streamed this text to the user before its provider died
 * mid-task. Without this the continuation model restates the whole answer and
 * the user reads it twice.
 */
export function renderContinuation(streamedText: string): string {
  return [
    'IMPORTANT: this turn is already in progress. The user has ALREADY been shown the following reply text, and the model writing it was cut off mid-task by a provider failure:',
    '',
    streamedText.trim(),
    '',
    'Pick up exactly where that left off and finish the job. Do NOT repeat what was already said, do not re-introduce yourself, and do not start the task over: continue it.',
  ].join('\n');
}

/** A result's text as it may be stored: a `--no-redact` turn's login links
 * must not outlive it. */
function storedOutput(result: GatheredResult, max: number): string {
  const output = toCompactText(result.output, max);
  return EMAIL_RESULT.test(result.toolName)
    ? redactSecrets(output).text
    : output;
}

/**
 * What this turn's tools were called with and returned, persisted alongside
 * the reasoning so the next three turns can use a fact kyto observed but never
 * typed into Slack (a decoded captcha, an id, a computed value). Most recent
 * first when over the turn's cap. Empty string when the turn ran no tools.
 */
export function renderObservations(results: GatheredResult[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const result of [...results].reverse()) {
    const block = `${result.toolName}(${toCompactText(result.input, OBSERVATION_INPUT_MAX)}) →\n${storedOutput(result, OBSERVATION_OUTPUT_MAX)}`;
    if (used + block.length > OBSERVATION_TURN_MAX && blocks.length > 0) {
      blocks.push(
        `[${results.length - blocks.length} earlier tool calls this turn not kept]`
      );
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.reverse().join('\n\n');
}

/**
 * One short line per tool call: what kyto DID this turn, for the thread digest
 * (compaction), which otherwise only knows what was said.
 */
export function renderActions(results: GatheredResult[]): string {
  const lines = results.map(
    (result) =>
      `${result.toolName}(${toCompactText(result.input, ACTION_INPUT_MAX)}) → ${storedOutput(result, ACTION_OUTPUT_MAX).replaceAll('\n', ' ')}`
  );
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.reverse()) {
    if (used + line.length > ACTIONS_TURN_MAX) {
      kept.push(`(${lines.length - kept.length} earlier calls)`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return kept.reverse().join('\n');
}

/**
 * Render gathered tool results as a prompt block the fallback model can answer
 * from without re-running the tools. Most recent results win when over the cap —
 * a turn that fell back nine searches deep must not hand the next model the
 * first nine and none of the recent ones.
 */
export function renderCarryover(results: GatheredResult[]): string {
  const recent = results.slice(-CARRYOVER_MAX_RESULTS);
  const lines = recent.map((result, index) => {
    const input = toCompactText(result.input, CARRYOVER_INPUT_MAX);
    const output = toCompactText(result.output, CARRYOVER_OUTPUT_MAX);
    return `${index + 1}. ${result.toolName}(${input})\n${output}`;
  });
  return [
    'A previous attempt already ran these tools and got these results. Use them to answer directly; do NOT re-run the same tools:',
    '',
    ...lines,
  ].join('\n');
}

/** A tool output as JSON a provider accepts; text when it isn't JSON. */
function toJson(value: unknown): JSONValue {
  try {
    return (JSON.parse(JSON.stringify(value) ?? 'null') as JSONValue) ?? null;
  } catch {
    return String(value);
  }
}

/** A carried result's size, measured as the text a provider will receive. */
function carriedSize(output: unknown): number {
  return typeof output === 'string'
    ? output.length
    : JSON.stringify(output ?? null).length;
}

/** Clamp a single oversized result so one giant output can't blow the budget. */
function clampCarriedOutput(output: unknown): unknown {
  if (carriedSize(output) <= CARRIED_RESULT_MAX) {
    return output;
  }
  const text =
    typeof output === 'string' ? output : JSON.stringify(output ?? null);
  return `${text.slice(0, CARRIED_RESULT_MAX)}\n…[clipped: this result was too large to carry across the fallback; re-run the tool if you need the rest]`;
}

/**
 * A fallback model's view of what the failed attempt already did: its tool
 * calls and results as REAL messages after the request, so it carries on from
 * them the way the first model would have, instead of reading a clipped text
 * summary (12 results, 1500 characters each). Bounded to the most recent
 * results within CARRIED_TOTAL_MAX: step-0 compaction can NOT shrink these —
 * they land as the first request's last step, which it keeps verbatim — so the
 * cap has to live here. A call to a tool this turn doesn't have (a hallucinated
 * name) is left out: providers refuse a call to an undefined tool.
 */
export function carriedMessages({
  results,
  toolNames,
}: {
  results: GatheredResult[];
  toolNames: ReadonlySet<string>;
}): ModelMessage[] {
  const valid = results.filter((result) => toolNames.has(result.toolName));
  if (valid.length === 0) {
    return [];
  }
  // Newest-first within a char budget: a fallback from a long attempt must not
  // re-ship every step's full output (see the constants above). A single result
  // bigger than the per-result cap is clamped rather than dropping the rest.
  const boundedReversed: GatheredResult[] = [];
  let used = 0;
  for (const result of [...valid].reverse()) {
    const output = clampCarriedOutput(result.output);
    const size = carriedSize(output);
    if (boundedReversed.length > 0 && used + size > CARRIED_TOTAL_MAX) {
      break;
    }
    used += size;
    boundedReversed.push({ ...result, output });
  }
  const kept = boundedReversed.reverse();
  const id = (index: number) => `carried-${index + 1}`;
  return [
    {
      content: kept.map((result, index) => ({
        input: result.input,
        toolCallId: id(index),
        toolName: result.toolName,
        type: 'tool-call' as const,
      })),
      role: 'assistant',
    },
    {
      content: kept.map((result, index) => ({
        output:
          typeof result.output === 'string'
            ? { type: 'text' as const, value: result.output }
            : { type: 'json' as const, value: toJson(result.output) },
        toolCallId: id(index),
        toolName: result.toolName,
        type: 'tool-result' as const,
      })),
      role: 'tool',
    },
  ];
}

// Tools whose result is public by nature: the open web, kyto's own computing.
const PUBLIC_TOOLS = new Set([
  'askQuestion',
  'browser',
  'deploySite',
  'fetchUrl',
  'generateImage',
  'getUser',
  'loadSkill',
  'loadTools',
  'mermaid',
  'poll',
  'react',
  'runJs',
  'searchWeb',
  'skip',
  'unreact',
  'upgradeModel',
]);

// Tools that read with someone's OWN access or hold their own data: private
// whatever came back.
const PRIVATE_TOOLS = new Set([
  'deleteMemory',
  'editMemory',
  'email',
  'fetchMemory',
  'getFile',
  'memory',
  'saveMemory',
  'slackBrowser',
  'slackScript',
]);

// A DM, a group DM or a private channel named in a result: Slack ids starting
// D or G (with a digit, so a shouted word like DEPRECATED isn't one), or
// Slack's own privacy flags.
const PRIVATE_CONVERSATION =
  /"(?:is_private|isPrivate|is_im|is_mpim)"\s*:\s*true|\b[DG](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/;

/**
 * Did this tool result carry someone's private data? Fails closed: anything
 * not known public is private when it names a non-public conversation, and the
 * tools that read with the asker's own access are private regardless.
 */
export function isPrivateObservation(result: GatheredResult): boolean {
  if (PUBLIC_TOOLS.has(result.toolName)) {
    return false;
  }
  if (
    PRIVATE_TOOLS.has(result.toolName) ||
    result.toolName.startsWith('mcp_')
  ) {
    return true;
  }
  return PRIVATE_CONVERSATION.test(
    `${stableInput(result.input)} ${stableInput(result.output)}`
  );
}
