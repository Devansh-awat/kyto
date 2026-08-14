import { describe, expect, test } from 'bun:test';
import { formatBanDuration, parseBanDuration } from './duration';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('parseBanDuration', () => {
  test('reads the units the owner actually types', () => {
    expect(parseBanDuration('1d')?.ms).toBe(DAY);
    expect(parseBanDuration('1h')?.ms).toBe(HOUR);
    expect(parseBanDuration('1w')?.ms).toBe(7 * DAY);
    expect(parseBanDuration('30m')?.ms).toBe(30 * MINUTE);
  });

  test('adds compound parts up', () => {
    expect(parseBanDuration('2h30m')?.ms).toBe(2 * HOUR + 30 * MINUTE);
    expect(parseBanDuration('1d 12h')?.ms).toBe(DAY + 12 * HOUR);
  });

  test('takes the words for an indefinite ban', () => {
    expect(parseBanDuration('forever')).toEqual({ ms: null });
    expect(parseBanDuration('perm')).toEqual({ ms: null });
  });

  test('refuses anything that is not a duration', () => {
    // The caller needs to tell "no time given" from "a typo": `1dave` must not
    // quietly become a one-day ban with the reason eaten.
    expect(parseBanDuration('1dave')).toBeNull();
    expect(parseBanDuration('spamming')).toBeNull();
    expect(parseBanDuration('')).toBeNull();
    expect(parseBanDuration('1')).toBeNull();
    expect(parseBanDuration('d')).toBeNull();
  });

  test('a zero duration is a slip, not a permanent ban', () => {
    expect(parseBanDuration('0d')).toBeNull();
    expect(parseBanDuration('0')).toBeNull();
  });

  test('caps a wild number instead of overflowing into nonsense', () => {
    const parsed = parseBanDuration('999999w');
    expect(parsed?.ms).toBe(365 * DAY);
    expect(new Date(Date.now() + (parsed?.ms ?? 0)).getFullYear()).toBeLessThan(
      2030
    );
  });
});

describe('formatBanDuration', () => {
  test('says it the way a person would', () => {
    expect(formatBanDuration(DAY)).toBe('1 day');
    expect(formatBanDuration(2 * HOUR + 30 * MINUTE)).toBe(
      '2 hours 30 minutes'
    );
    expect(formatBanDuration(null)).toBe('indefinitely');
    expect(formatBanDuration(30 * 1000)).toBe('under a minute');
  });
});
