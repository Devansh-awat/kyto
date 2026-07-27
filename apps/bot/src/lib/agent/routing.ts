import type { ModelAttempt } from '@repo/ai';
// From the env-free module on purpose: this file must stay importable (and so
// testable) without a valid API-key environment.
import { isGatewayStatus } from '@repo/ai/gateway-retry';
import { GEMINI_PROVIDER, HACKCLUB_PROVIDER } from '@repo/ai/providers/names';

// The order kyto falls back in. Split out of the agent loop because this is
// where the worst regression in the project's history lived, and it was guarded
// by a comment.

/** Identity of an attempt for "already tried" purposes: provider AND model. */
export function attemptKey(attempt: ModelAttempt): string {
  return `${attempt.provider}:${attempt.model}`;
}

/**
 * The queue walked once PRIMARY_ATTEMPT fails, by TIER:
 *
 *   1. the HackClub rungs, in list order (LEADERBOARD_FALLBACK — cheap K2-class
 *      models, deliberately no longer the arena's expensive top end);
 *   2. the owner's Gemini key, the cheap last resort.
 *
 * Within each tier, the list's own order decides.
 *
 * This used to pivot on the primary's index in the leaderboard and walk "up"
 * from it — logic inherited from `openrouter/auto`, which resolved to a real
 * leaderboard rank. The pinned primary was a rung appended at the BOTTOM of that
 * list, so "up" reversed the leaderboard and kyto fell back WORST FIRST: it
 * landed on nvidia/nemotron, which looped "@devansh" a few hundred times into a
 * public thread, and would only ever have reached opus-4.8 after every junk rung
 * failed. Keep the queue explicit and rank-ordered; do NOT reintroduce a pivot.
 */
export function buildFallbackQueue(
  leaderboard: ModelAttempt[]
): ModelAttempt[] {
  const tier = (provider: string) =>
    leaderboard.filter((candidate) => candidate.provider === provider);
  return [...tier(HACKCLUB_PROVIDER), ...tier(GEMINI_PROVIDER)];
}

/**
 * Pick the next shared-service attempt: models already tried are skipped, and so
 * is any tier written off mid-walk.
 *
 * The tier skip is applied HERE, at selection time, rather than baked into the
 * queue — a tier can go out part-way through the walk (HackClub over budget or
 * down), and there is no point retrying a dead proxy or a spent quota one rung
 * at a time.
 */
/**
 * Does this failure mean the whole HackClub tier is unusable for this turn?
 *
 * Yes for a status the proxy reported that is about the PROXY — auth, rate
 * limit, budget, a real 5xx from it — because every rung shares one proxy and
 * one budget, so the next rung fails identically.
 *
 * No for `undefined` (a fault kyto raised itself: an empty response, a
 * degenerate loop — those are about the MODEL) and no for a gateway status,
 * which is a single lost request: measured 2026-07-27, the proxy 504s
 * per-request, hitting opus-4.8 while kimi-k2.7 and glm-5.2 answered fine
 * seconds either side. Condemning the tier on one of those is what used to send
 * a live thread straight past every HackClub rung onto Gemini.
 */
export function condemnsHackclub(status: number | undefined): boolean {
  return status !== undefined && !isGatewayStatus(status);
}

export function selectNextAttempt({
  failedKeys,
  queue,
  skipHackclub,
}: {
  failedKeys: ReadonlySet<string>;
  queue: ModelAttempt[];
  skipHackclub: boolean;
}): ModelAttempt | undefined {
  return queue.find(
    (candidate) =>
      !(
        failedKeys.has(attemptKey(candidate)) ||
        (skipHackclub && candidate.provider === HACKCLUB_PROVIDER)
      )
  );
}
