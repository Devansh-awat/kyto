import { describe, expect, test } from 'bun:test';
import { pickReasoningEffort } from './agent';
import {
  catalogAttempt,
  LUNA_MODEL,
  PRIMARY_ATTEMPT,
} from './providers/attempts';

const LUNA_ATTEMPT = catalogAttempt(LUNA_MODEL);

describe('pickReasoningEffort on haiku', () => {
  test('draws only low or medium, never none', () => {
    const seen = new Set<string>();
    for (let thread = 0; thread < 60; thread++) {
      const threadId = `slack:C0TEST:${thread}`;
      for (let i = 0; i < 12; i++) {
        seen.add(
          pickReasoningEffort({ attempt: PRIMARY_ATTEMPT, threadId }).effort
        );
      }
    }
    expect(seen).toEqual(new Set(['low', 'medium']));
  });
});

describe('pickReasoningEffort on luna', () => {
  test('a luna thread keeps one effort, and threads cover both', () => {
    const seen = new Set<string>();
    for (let thread = 0; thread < 60; thread++) {
      const threadId = `slack:C0TEST:${thread}`;
      const picks = new Set(
        Array.from(
          { length: 12 },
          () => pickReasoningEffort({ attempt: LUNA_ATTEMPT, threadId }).effort
        )
      );
      expect(picks.size).toBe(1);
      for (const pick of picks) {
        seen.add(pick);
      }
    }
    expect(seen).toEqual(new Set(['low', 'medium']));
  });
});
