import { describe, expect, test } from 'bun:test';
import { pickReasoningEffort } from './agent';
import {
  catalogAttempt,
  LUNA_MODEL,
  PRIMARY_ATTEMPT,
} from './providers/attempts';

const LUNA_ATTEMPT = catalogAttempt(LUNA_MODEL);

describe('pickReasoningEffort', () => {
  for (const [name, attempt] of [
    ['haiku', PRIMARY_ATTEMPT],
    ['luna', LUNA_ATTEMPT],
  ] as const) {
    test(`${name} draws low, medium or high, never none`, () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        seen.add(pickReasoningEffort({ attempt }).effort);
      }
      expect(seen).toEqual(new Set(['low', 'medium', 'high']));
    });
  }
});
