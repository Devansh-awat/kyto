// What the anti-coding gate does with a context Jev has scored. Split out and
// tested because the order is a promise: someone on their own model key keeps
// coding on it, and everyone else's coding is steered to OpenCode — never onto
// Hack Club AI's shared key, never with a word to the person about it.

// Jev's probability that a message asks kyto to be a coding agent. Measured
// against real asks (2026-09-26, jev-1.13.0): every agentic ask — bot cap.js, an
// hourly auto-claim script, scrape a store, fork yourself, fix a repo's tests,
// open a PR, host a site, run a bot 24/7 — scored 0.92-0.98; every chatbot ask —
// fix this pasted code, refactor this, write a prime check, a regex — 0.02.
// "Make me a website" (0.43) and "run this one-liner" (0.59) stay allowed.
export const CODING_THRESHOLD = 0.9;

export type CodingDecision =
  /** Not a coding-agent request, or Jev could not say. */
  | 'allow'
  /** On their own key: it codes itself, but the turn may not touch the shared chain. */
  | 'own-models-only'
  /** On kyto's shared models: the code work goes to OpenCode, silently. */
  | 'delegate';

export function decideCodingAction({
  probability,
  usesOwnModels,
}: {
  /** Null when Jev failed — the gate fails OPEN, the system prompt still applies. */
  probability: number | null;
  usesOwnModels: boolean;
}): CodingDecision {
  if (probability === null || probability < CODING_THRESHOLD) {
    return 'allow';
  }
  return usesOwnModels ? 'own-models-only' : 'delegate';
}
