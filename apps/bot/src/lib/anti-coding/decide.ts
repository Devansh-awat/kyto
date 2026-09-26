// What the anti-coding gate does with a message Jev has scored. Split out and
// tested because every branch here is a promise to a specific person: the owner
// is never stopped, someone on their own model key is never warned, and a stranger
// is warned exactly once before being banned. Getting the order wrong bans the
// owner or lets a custom-key user's coding turn fall back onto Hack Club AI.

// Jev's probability that a message asks kyto to be a coding agent. Measured
// against real asks (2026-09-26, jev-1.13.0): every build/fix/refactor/deploy/PR
// request scored ≥0.96, while "run this one-liner" scored 0.80, "write a regex"
// 0.46 and "find the bug in this" 0.13 — all of which kyto is allowed to do.
export const CODING_THRESHOLD = 0.9;

// A second catch inside this window after a warning is a ban, not another warning.
export const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CODING_BAN_MS = 2 * 60 * 60 * 1000;

export type CodingDecision =
  /** Not a coding-agent request, or Jev could not say. */
  | 'allow'
  /** On their own key: no warning, but the turn may not touch the shared chain. */
  | 'own-models-only'
  /** The owner: an ephemeral note, then the turn runs as normal. */
  | 'owner-warning'
  /** Anyone else: the turn is stopped and it counts as a strike. */
  | 'strike';

export function decideCodingAction({
  isOwner,
  probability,
  usesOwnModels,
}: {
  isOwner: boolean;
  /** Null when Jev failed — the gate fails OPEN, the system prompt still applies. */
  probability: number | null;
  usesOwnModels: boolean;
}): CodingDecision {
  if (probability === null || probability < CODING_THRESHOLD) {
    return 'allow';
  }
  // Before the owner check: the owner on his own key is spending his own money
  // too, and "custom API → no warning" was the rule as given.
  if (usesOwnModels) {
    return 'own-models-only';
  }
  return isOwner ? 'owner-warning' : 'strike';
}

/** A strike is a ban when the previous warning is still inside the window. */
export function isRepeatOffence({
  now,
  previousWarning,
}: {
  now: Date;
  previousWarning: Date | null;
}): boolean {
  return (
    previousWarning !== null &&
    now.getTime() - previousWarning.getTime() < WARNING_WINDOW_MS
  );
}
