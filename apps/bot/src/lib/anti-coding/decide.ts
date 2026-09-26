// What the anti-coding gate does with a message Jev has scored. Split out and
// tested because every branch here is a promise to a specific person: the owner
// is never stopped, someone on their own model key is never warned, and a stranger
// is warned exactly once before being banned. Getting the order wrong bans the
// owner or lets a custom-key user's coding turn fall back onto Hack Club AI.

// Jev's probability that a message asks kyto to be a coding agent. Measured
// against real asks (2026-09-26, jev-1.13.0): every agentic ask — bot cap.js, an
// hourly auto-claim script, scrape a store, fork yourself, fix a repo's tests,
// open a PR, host a site, run a bot 24/7 — scored 0.92-0.98; every chatbot ask —
// fix this pasted code, refactor this, write a prime check, a regex — 0.02.
// "Make me a website" (0.43) and "run this one-liner" (0.59) stay allowed.
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
