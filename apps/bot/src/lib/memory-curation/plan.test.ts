import { describe, expect, test } from 'bun:test';
import { checkPlan, mergedBody } from '@/lib/memory-curation/plan';

const now = new Date('2026-10-08T00:00:00Z');
const old = new Date('2026-08-01T00:00:00Z');
const recent = new Date('2026-10-05T00:00:00Z');
const memories = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  updatedAt: index < 8 ? old : recent,
}));

describe('checkPlan', () => {
  test('drops merges naming unknown or repeated ids', () => {
    const plan = checkPlan({
      memories,
      now,
      plan: {
        merges: [
          { absorb: [2], keep: 1, reason: 'dup', summary: 's' },
          { absorb: [1], keep: 3, reason: 'reuses 1', summary: 's' },
          { absorb: [99], keep: 4, reason: 'unknown', summary: 's' },
          { absorb: [5, 5], keep: 6, reason: 'repeat', summary: 's' },
        ],
        remove: [],
      },
    });
    expect(plan.merges.map((merge) => merge.keep)).toEqual([1]);
  });

  test('removes only old memories, at most a fifth of them, never a merged one', () => {
    const plan = checkPlan({
      memories,
      now,
      plan: {
        merges: [{ absorb: [2], keep: 1, reason: 'dup', summary: 's' }],
        remove: [
          { id: 1, reason: 'merged already' },
          { id: 9, reason: 'too recent' },
          { id: 3, reason: 'stale' },
          { id: 4, reason: 'stale' },
          { id: 5, reason: 'over the cap' },
        ],
      },
    });
    expect(plan.remove.map((entry) => entry.id)).toEqual([3, 4]);
  });
});

describe('mergedBody', () => {
  test('keeps every body in full', () => {
    const body = mergedBody({
      absorbed: [{ body: 'B'.repeat(5000), title: 'second' }],
      kept: { body: 'first' },
    });
    expect(body).toContain('first');
    expect(body).toContain(`## second\n\n${'B'.repeat(5000)}`);
  });
});
