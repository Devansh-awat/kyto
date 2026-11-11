import { isPromptConstructionError } from '@/lib/agent/routing';
import { errorMessage, errorStatus } from '@/lib/utils/error';
import type { AgentErrorStage } from '@/types/agent';

// Thrown when a turn fails after HackClub returned the daily-spend-limit 429 AND
// every fallback (cheaper HackClub rungs, then baishui) also failed — i.e. the
// daily budget is the root cause, not a transient provider error. Carries the
// raw 429 text (e.g. "Daily spending limit of $3 reached") so the user-facing
// message can name the actual dollar amount.
export class BudgetExhaustedError extends Error {
  constructor(detail?: string, options?: { cause?: unknown }) {
    super(detail ?? 'Daily model spending limit reached.', options);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * The provider died in the middle of a multi-step attempt. The AI SDK does not
 * throw for this: a step that fails after its internal retries is emitted as an
 * `error` part and the stream simply ends. If the model had already streamed
 * reply text, the turn used to look "handled" and kyto went quiet mid-task with
 * no error anywhere except a raw SDK blob on stderr.
 *
 * Raising it turns that silence into a real failure, which lets the fallback
 * chain CONTINUE the turn on the next model (the one case where a turn that
 * already produced text is allowed to fall back — see renderContinuation).
 */
export class StreamInterruptedError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'StreamInterruptedError';
  }
}

/**
 * The model fell into a token loop: it stopped answering and started repeating
 * itself (the same line, or the same phrase, over and over). Formally this is
 * reply text, so the old loop counted it as a handled turn and posted it —
 * `nvidia/nemotron-3-ultra-550b-a55b` streamed "@devansh" several hundred times
 * into a public thread that way.
 *
 * Repetition is not an answer. The guard raises this as soon as it trips, which
 * aborts the attempt, keeps the loop out of Slack, and falls back to another
 * model — one of the two cases (with StreamInterruptedError) where a turn that
 * already streamed text is still allowed to fall back.
 */
export class DegenerateOutputError extends Error {
  constructor(model: string, options?: { cause?: unknown }) {
    super(
      `Model ${model} started repeating itself instead of answering.`,
      options
    );
    this.name = 'DegenerateOutputError';
  }
}

/**
 * The acting user brought their own model key(s), every one of them failed, and
 * they did NOT opt into spending the shared service budget as a backstop. Only
 * they can fix it, so the message points at their App Home tab rather than
 * reading as a kyto outage.
 */
export class ByokExhaustedError extends Error {
  constructor(detail?: string, options?: { cause?: unknown }) {
    super(detail ?? 'Your model key failed.', options);
    this.name = 'ByokExhaustedError';
  }
}

const SPEND_AMOUNT_PATTERN = /\$\d+(?:\.\d+)?/;

const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;

// Hack Club's daily spend window is the UTC day (hackclub/ai
// `startOfUtcDay`, and `timezone DEFAULT 'UTC'` on its billing policies). This
// used to count to London midnight, an hour late all summer.
export function timeUntilUtcMidnight(now: Date = new Date()): {
  hours: number;
  minutes: number;
} {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  const left = Math.ceil((next - now.getTime()) / MS_PER_MINUTE);
  return {
    hours: Math.floor(left / MINUTES_PER_HOUR),
    minutes: left % MINUTES_PER_HOUR,
  };
}

const CREDIT_ERROR_PATTERN =
  /\b(credit|credits|quota|daily limit|requires more credits)\b/i;
const CONTEXT_ERROR_PATTERN =
  /\b(max_tokens|maximum context|context length|too many tokens)\b/i;
const PROVIDER_TIMEOUT_PATTERN =
  /\b(5\d\d|gateway time-out|gateway timeout|cloudflare|timeout occurred|origin_response_timeout)\b/i;

export function agentErrorMessage({
  error,
  stage = 'before_output',
}: {
  error: unknown;
  stage?: AgentErrorStage;
}): string {
  const message = errorMessage(error);
  // Budget exhaustion is the real cause regardless of how far the turn got, so
  // it wins over the stage-based messages. Name the daily cap when the 429 text
  // carried it. Deliberately does NOT explain the proxy's pessimistic limit
  // accounting — just that the daily budget is spent.
  // The user's own key is the root cause and only they can fix it, so this wins
  // over the stage-based messages too. Deliberately does not quote the
  // provider's raw rejection into a possibly-public channel — the detail lives
  // in their App Home tab, where only they can see it.
  if (error instanceof ByokExhaustedError) {
    return "_your own model failed on this one, and i didn't use my shared models because you chose not to. if you'd rather i did, switch to shared models in my app home (the model keys section has a shared-model fallback toggle). the model keys section also shows what the provider said_";
  }
  if (error instanceof BudgetExhaustedError) {
    const amount = message.match(SPEND_AMOUNT_PATTERN)?.[0] ?? '$3';
    const { hours, minutes } = timeUntilUtcMidnight();
    return `_my daily model budget (${amount}/day) is used up, so every model is out of credits for today. it resets at utc midnight, in ${hours}h ${minutes}m_`;
  }
  // Kyto assembled a prompt the SDK refuses to send. No model ever saw it, so
  // "the provider failed" would be a lie and "try again" is useless advice —
  // the same thread state rebuilds the same broken prompt. Say what it is.
  if (isPromptConstructionError(error)) {
    return "_i built a broken prompt for this one and couldn't send it. that's a bug in me, not a model outage, and a new thread works around it_";
  }
  if (stage === 'after_text') {
    return "_i hit an error while sending this, so the reply above may be cut short. send a follow-up and i'll pick up from here_";
  }
  if (stage === 'after_progress') {
    return "_i hit an error partway through. the steps above show what got done, send a follow-up and i'll pick up from there_";
  }
  if (CREDIT_ERROR_PATTERN.test(message)) {
    return "_i'm out of model credits for this one. try again later, or ask for something smaller_";
  }
  if (CONTEXT_ERROR_PATTERN.test(message)) {
    return "_that's too big for the model budget i have right now. try a shorter ask or a new thread_";
  }
  if (PROVIDER_TIMEOUT_PATTERN.test(message)) {
    return "_every model i tried timed out. try again in a bit, or send a shorter follow-up and i'll continue from here_";
  }
  return "_i couldn't answer this, every model i tried failed. send it again in a bit_";
}

/**
 * Whether a stream ended on the model provider's failure, the only thing that
 * may leave cards drawn as "Something went wrong" (owner's rule, #20). kyto's
 * own daily cap is excluded even though its cause is a provider 429: a
 * BudgetExhaustedError is answered by agentErrorMessage's budget line instead.
 */
export function isProviderFailure(error: unknown): boolean {
  return (
    !(error instanceof BudgetExhaustedError) && errorStatus(error) !== undefined
  );
}
