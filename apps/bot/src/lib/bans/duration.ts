// How long a ban lasts, from what the owner typed.
//
// Split out and tested because it is the only part of banning with a wrong
// answer available: getting this off by a factor of sixty is the difference
// between a minute and an hour of someone being ignored, and the mistake is
// invisible until they complain.

const UNIT_MS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

// Words that mean "until I lift it". `0` is deliberately NOT one of them: a
// typed zero is far more likely to be a slip than an intent to ban forever.
const FOREVER = new Set(['forever', 'perm', 'permanent', 'indefinite']);

// One year. A ban longer than this is indistinguishable from forever, and the
// cap is what stops `999999w` overflowing into a nonsense date.
const MAX_MS = 365 * 24 * 60 * 60 * 1000;

export interface BanDuration {
  /** Null = until lifted by hand. */
  ms: number | null;
}

/**
 * Parse `1d`, `2h30m`, `90m`, `forever`. Returns null when the text is not a
 * duration at all, which is how the caller tells "no time given" from "a time
 * that makes no sense" — the first is worth a default, the second is a typo
 * that must not silently become one.
 */
export function parseBanDuration(input: string): BanDuration | null {
  const text = input.trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (FOREVER.has(text)) {
    return { ms: null };
  }
  // Every part must be <number><unit> with nothing else in it, so `1dave` is a
  // reason that happens to start with a digit rather than a duration.
  if (!/^(\d+\s*[smhdw])+$/.test(text.replace(/\s+/g, ''))) {
    return null;
  }
  let total = 0;
  for (const [, amount, unit] of text
    .replace(/\s+/g, '')
    .matchAll(/(\d+)([smhdw])/g)) {
    total += Number(amount) * (UNIT_MS[unit ?? ''] ?? 0);
  }
  if (total <= 0) {
    return null;
  }
  return { ms: Math.min(total, MAX_MS) };
}

/** "1 day", "2 hours 30 minutes" — for telling someone what they just got. */
export function formatBanDuration(ms: number | null): string {
  if (ms === null) {
    return 'indefinitely';
  }
  const parts: string[] = [];
  let left = ms;
  for (const [size, name] of [
    [UNIT_MS.w, 'week'],
    [UNIT_MS.d, 'day'],
    [UNIT_MS.h, 'hour'],
    [UNIT_MS.m, 'minute'],
  ] as const) {
    const count = Math.floor(left / (size ?? 1));
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      left -= count * (size ?? 1);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'under a minute';
}
