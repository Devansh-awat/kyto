import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { LUNA_MODEL, MERCURY_MODEL, PRIMARY_MODEL } from '@repo/ai';
import { experimentAttempt } from './model-choice';

const THREADS = Array.from({ length: 3000 }, (_, index) => `slack:C1:${index}`);

describe('experimentAttempt', () => {
  test('splits threads into thirds', () => {
    const counts = new Map<string, number>();
    for (const thread of THREADS) {
      const { model } = experimentAttempt(thread);
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
    for (const model of [PRIMARY_MODEL, LUNA_MODEL, MERCURY_MODEL]) {
      expect(counts.get(model) ?? 0).toBeGreaterThan(900);
      expect(counts.get(model) ?? 0).toBeLessThan(1100);
    }
  });

  // Moving a thread off its model throws its warm cache away.
  test('never moves a thread between haiku and luna', () => {
    for (const thread of THREADS) {
      const { model } = experimentAttempt(thread);
      if (model === MERCURY_MODEL) {
        continue;
      }
      const firstByte = createHash('sha256').update(thread).digest()[0] ?? 0;
      expect(model).toBe(firstByte % 2 === 0 ? PRIMARY_MODEL : LUNA_MODEL);
    }
  });
});
