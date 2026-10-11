import { describe, expect, test } from 'bun:test';
import { pickReasoningEffort } from './agent';
import {
  catalogAttempt,
  LUNA_MODEL,
  PRIMARY_ATTEMPT,
} from './providers/attempts';

const LUNA_ATTEMPT = catalogAttempt(LUNA_MODEL);

// Anthropic caches thinking-on and thinking-off requests apart, so a haiku
// thread that flipped between `none` and low/medium re-read nothing.
describe('pickReasoningEffort on haiku', () => {
  test('a thread is either always none or never none', () => {
    const arms = new Set<string>();
    for (let thread = 0; thread < 60; thread++) {
      const threadId = `slack:C0TEST:${thread}`;
      const picks = new Set(
        Array.from(
          { length: 12 },
          () =>
            pickReasoningEffort({ attempt: PRIMARY_ATTEMPT, threadId }).effort
        )
      );
      const none = picks.has('none');
      if (none) {
        expect([...picks]).toEqual(['none']);
      } else {
        for (const pick of picks) {
          expect(['low', 'medium']).toContain(pick);
        }
      }
      arms.add(none ? 'none' : 'thinking');
    }
    expect(arms).toEqual(new Set(['none', 'thinking']));
  });

  test('a luna thread keeps one effort, and threads cover all three', () => {
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
    expect(seen).toEqual(new Set(['none', 'low', 'medium']));
  });
});
