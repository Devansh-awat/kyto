import type { ModelAttempt } from '@repo/ai';
import {
  attemptKey,
  buildFallbackQueue,
  selectNextAttempt,
} from '@/lib/agent/routing';

// How many non-budget HackClub PROXY failures in a turn before we treat HackClub
// as down and skip its remaining rungs. ONE is enough: every HackClub rung shares
// one proxy and one budget, so a rung that fails for a non-model reason (5xx,
// connection error, rate limit) means the next rung fails identically. Trying a
// second one only bought another "Thinking · fallback" card before the same
// verdict. The owner's own Gemini key is a genuinely separate quota, so jump.
//
// Only a failure the PROXY reported counts (`errorStatus` found an HTTP status).
// This matters because the PRIMARY is itself a HackClub call: the model-level
// faults kyto raises on its own — an empty response, tools-but-no-reply, a
// degenerate loop — carry no status, and they say nothing about the proxy. If
// they counted, one bad completion from the primary would write off every
// remaining HackClub rung for that turn and drop the user straight onto Gemini.
//
// A GATEWAY status is excluded for the same reason (`isGatewayStatus`). Measured
// 2026-07-27: the proxy 504s per REQUEST, not per model and not tier-wide — a
// probe caught opus-4.8 504 while kimi-k2.7 and glm-5.2 answered fine seconds
// either side. So a 504 that survived the retries in gateway-retry.ts says
// "we lost that request", not "the proxy is down", and condemning the tier on
// one of them is how a single dropped request used to skip every HackClub rung
// and land a live thread on gemini-3.1-flash-lite.
const HACKCLUB_OUTAGE_THRESHOLD = 1;

/**
 * Which model a turn tries next, and what it has learned about the ones that
 * failed. Pulled out of the agent loop so the walk is testable: the order and
 * the skip rules here are where the worst routing regression came from.
 *
 * Shared chain: the sticky upgrade (if this thread escalated) or the primary,
 * then the primary, then the fallback queue in tier order — skipping failed
 * rungs, and every Hack Club rung once its budget is spent or it looks down.
 * Own attempts (a person's ChatGPT account / keys) go before or after it per
 * `routing.ownFirst`, or alone when the turn was caught doing coding work on
 * their own key.
 */
export function createAttemptRouter({
  cached,
  fallback,
  hackclubProvider,
  ownModelsOnly,
  primary,
  routing,
  stickyUpgrade,
}: {
  /** What earlier turns found dead (lib/agent/fallback-cache). */
  cached: { providers: string[]; rungs: string[] };
  fallback: ModelAttempt[];
  hackclubProvider: string;
  /** Read at every step: the coding monitor can flip it mid-turn. */
  ownModelsOnly: () => boolean;
  primary: ModelAttempt;
  routing: {
    own: ModelAttempt[];
    ownFirst: boolean;
    serviceFallback: boolean;
  };
  stickyUpgrade: ModelAttempt | undefined;
}) {
  const ownQueue = [...routing.own];
  const failedKeys = new Set<string>(cached.rungs);
  let triedPrimary = false;
  let fallbackQueue: ModelAttempt[] | undefined;
  let budgetExhausted = cached.providers.includes(hackclubProvider);
  let spendLimitMessage: string | undefined;
  let hackclubFailures = 0;
  let hackclubDown = false;

  const skipShared = (candidate: ModelAttempt): boolean =>
    failedKeys.has(attemptKey(candidate)) ||
    ((budgetExhausted || hackclubDown) &&
      candidate.provider === hackclubProvider);

  const nextShared = (): ModelAttempt | undefined => {
    if (!triedPrimary) {
      triedPrimary = true;
      // A thread that escalated leads with the strong rung; if it fails, the
      // walk carries on from the primary exactly as it always did.
      const first = stickyUpgrade ?? primary;
      if (!skipShared(first)) {
        return first;
      }
    }
    if (stickyUpgrade && !skipShared(primary)) {
      return primary;
    }
    fallbackQueue ??= buildFallbackQueue(fallback);
    return selectNextAttempt({
      failedKeys,
      queue: fallbackQueue,
      skipHackclub: budgetExhausted || hackclubDown,
    });
  };

  return {
    get budgetExhausted() {
      return budgetExhausted;
    },
    get spendLimitMessage() {
      return spendLimitMessage;
    },
    hasFailed: (attempt: ModelAttempt): boolean =>
      failedKeys.has(attemptKey(attempt)),
    markFailed(attempt: ModelAttempt): void {
      failedKeys.add(attemptKey(attempt));
    },
    /** Hack Club's daily spend limit: every Hack Club rung would 429 too. */
    markSpendLimit(message: string): void {
      budgetExhausted = true;
      spendLimitMessage ??= message;
    },
    /** A proxy-reported Hack Club failure (see condemnsHackclub). */
    markHackclubFailure(): void {
      hackclubFailures += 1;
      if (hackclubFailures >= HACKCLUB_OUTAGE_THRESHOLD) {
        hackclubDown = true;
      }
    },
    /** The next attempt to run, or undefined when everything is spent. */
    next(): ModelAttempt | undefined {
      // A custom-key user's turn caught doing coding-agent work: their own
      // attempts only, so it never lands on Hack Club AI.
      if (ownModelsOnly()) {
        return ownQueue.shift();
      }
      if (routing.ownFirst) {
        const own = ownQueue.shift();
        if (own) {
          return own;
        }
        // Own attempts exhausted and the person didn't opt into the shared
        // chain: the turn stops (ByokExhaustedError upstream).
        if (routing.own.length > 0 && !routing.serviceFallback) {
          return;
        }
        return nextShared();
      }
      // Shared-first: kyto's models lead, the person's own are the last resort.
      return nextShared() ?? ownQueue.shift();
    },
    /**
     * Forget what earlier turns remembered as dead. The cache must never be
     * what leaves a turn with nothing to try.
     */
    resetCachedDeadness(): void {
      failedKeys.clear();
      budgetExhausted = false;
      triedPrimary = false;
    },
  };
}
