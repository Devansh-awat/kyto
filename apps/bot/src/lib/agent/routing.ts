import type { ModelAttempt } from '@repo/ai';
// From the env-free module on purpose: this file must stay importable (and so
// testable) without a valid API-key environment.
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
 *   1. the HackClub leaderboard in RANK order, BEST FIRST (opus-4.8 down);
 *   2. the owner's Gemini key, the cheap last resort.
 *
 * Within each tier, the leaderboard's own order decides.
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
