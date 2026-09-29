// Remembering, ACROSS turns, which of kyto's shared rungs are dead right now
// (owner's ask, 2026-09-29, after coolton's fallback cache — minus its
// background probe, which the owner did not want).
//
// Before this, every turn re-discovered the same outage: a spent Hack Club cap
// cost each new message a doomed request to the primary and a "Thinking ·
// fallback" card before the walk moved on. Now a HARD failure is remembered for
// a while and the next turn starts past it.
//
// Only hard failures count — ones that will fail identically on the next turn:
// the key was refused (401/403), the model is gone (404), the account is out of
// money (402, Hack Club's daily spend limit). A 429, a 5xx, a timeout, an empty
// reply or a looping model says nothing about the NEXT request and is never
// cached; that is what the in-turn walk is for.
//
// Deliberately NOT ported: coolton moves the last WORKING provider to the front.
// kyto's primary is a choice, not a guess, and one fallback that happened to
// answer must not displace it. With no probe, expiry is how a rung comes back.

const DEAD_FOR_MS = 30 * 60 * 1000;

// Statuses that mean "this will fail the same way next turn too".
const HARD_STATUSES = new Set([401, 402, 403, 404]);

interface Entry {
  reason: string;
  until: number;
}

const deadRungs = new Map<string, Entry>();
const deadTiers = new Map<string, Entry>();

/** Is this failure worth remembering across turns? */
export function isHardFailure({
  spendLimit,
  status,
}: {
  /** The failure matched the provider's out-of-budget message. */
  spendLimit: boolean;
  status: number | undefined;
}): boolean {
  return spendLimit || (status !== undefined && HARD_STATUSES.has(status));
}

export function markRungDead({
  key,
  now = Date.now(),
  reason,
}: {
  key: string;
  now?: number;
  reason: string;
}): void {
  deadRungs.set(key, { reason, until: now + DEAD_FOR_MS });
}

/** A whole provider (every rung behind one budget) is out, e.g. Hack Club. */
export function markTierDead({
  now = Date.now(),
  provider,
  reason,
}: {
  now?: number;
  provider: string;
  reason: string;
}): void {
  deadTiers.set(provider, { reason, until: now + DEAD_FOR_MS });
}

/** A rung just answered: whatever was remembered about it (or its tier) is stale. */
export function markAlive({
  key,
  provider,
}: {
  key: string;
  provider: string;
}): void {
  deadRungs.delete(key);
  deadTiers.delete(provider);
}

function live(map: Map<string, Entry>, now: number): string[] {
  const out: string[] = [];
  for (const [key, entry] of map) {
    if (entry.until > now) {
      out.push(key);
    } else {
      map.delete(key);
    }
  }
  return out;
}

/** What a new turn should start past: dead rung keys and dead providers. */
export function cachedDeadness(now = Date.now()): {
  providers: string[];
  rungs: string[];
} {
  return { providers: live(deadTiers, now), rungs: live(deadRungs, now) };
}

/** Forget everything (every rung was dead, so the cache must not strand a turn). */
export function clearFallbackCache(): void {
  deadRungs.clear();
  deadTiers.clear();
}
