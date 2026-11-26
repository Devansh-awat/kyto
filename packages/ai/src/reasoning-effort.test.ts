import { describe, expect, test } from 'bun:test';
import { pickReasoningEffort } from './agent';
import { PRIMARY_ATTEMPT } from './providers/attempts';

describe('pickReasoningEffort', () => {
  test('the primary draws medium or high, never low or none', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickReasoningEffort({ attempt: PRIMARY_ATTEMPT }).effort);
    }
    expect(seen).toEqual(new Set(['medium', 'high']));
  });
});
