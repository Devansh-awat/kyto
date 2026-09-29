import { beforeEach, describe, expect, test } from 'bun:test';
import {
  cachedDeadness,
  clearFallbackCache,
  isHardFailure,
  markAlive,
  markRungDead,
  markTierDead,
} from './fallback-cache';

beforeEach(() => clearFallbackCache());

describe('isHardFailure', () => {
  test('auth, missing model and out-of-money are hard', () => {
    for (const status of [401, 402, 403, 404]) {
      expect(isHardFailure({ spendLimit: false, status })).toBe(true);
    }
    expect(isHardFailure({ spendLimit: true, status: 429 })).toBe(true);
  });

  test('rate limits, gateway errors and model faults are not', () => {
    for (const status of [429, 500, 502, 503, 504, undefined]) {
      expect(isHardFailure({ spendLimit: false, status })).toBe(false);
    }
  });
});

describe('the cache', () => {
  test('a dead rung is skipped until it expires', () => {
    markRungDead({ key: 'hackclub:a', now: 0, reason: '404' });
    expect(cachedDeadness(1000).rungs).toEqual(['hackclub:a']);
    expect(cachedDeadness(31 * 60 * 1000).rungs).toEqual([]);
  });

  test('a dead tier is remembered separately from its rungs', () => {
    markTierDead({ now: 0, provider: 'hackclub', reason: 'spend limit' });
    expect(cachedDeadness(1).providers).toEqual(['hackclub']);
  });

  test('an answer clears both the rung and its tier', () => {
    markRungDead({ key: 'hackclub:a', now: 0, reason: '404' });
    markTierDead({ now: 0, provider: 'hackclub', reason: 'spend' });
    markAlive({ key: 'hackclub:a', provider: 'hackclub' });
    expect(cachedDeadness(1)).toEqual({ providers: [], rungs: [] });
  });
});
