import { describe, expect, test } from 'bun:test';
import {
  planThinkingCompaction,
  renderThinking,
  tail,
} from './thinking-render';

const big = (label: string, size: number) => `${label}${'x'.repeat(size)}END`;

describe('tail', () => {
  test('keeps the END of a turn, not the start', () => {
    // The tail is where a turn worked out what was going on; the head is the
    // tool output it was reasoning from.
    const result = tail('abcdefghij', 4);
    expect(result).toContain('ghij');
    expect(result).not.toContain('abcd');
  });

  test('says so when it truncated, and stays silent when it did not', () => {
    expect(tail('short', 100)).toBe('short');
    expect(tail('abcdefghij', 4)).toContain('dropped');
  });
});

describe('planThinkingCompaction', () => {
  test('nothing is folded under the budget', () => {
    const turns = [{ text: 'a' }, { text: 'b', tools: 'c' }];
    expect(planThinkingCompaction(turns, 100)).toEqual([]);
  });

  test('tool results count toward the budget', () => {
    const turns = [
      { text: 'a', tools: 'x'.repeat(60) },
      { text: 'b', tools: 'x'.repeat(60) },
    ];
    expect(planThinkingCompaction(turns, 100)).toEqual([0]);
  });

  test('folds the oldest back to half the budget, never the newest', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({
      text: big(`t${i}`, 30),
    }));
    // 5 × 34 = 170 > 100 → fold oldest until ≤ 50 left.
    expect(planThinkingCompaction(turns, 100)).toEqual([0, 1, 2, 3]);
    expect(planThinkingCompaction([{ text: big('only', 500) }], 100)).toEqual(
      []
    );
  });

  test('an existing summary is never folded as a turn', () => {
    const turns = [
      { summary: true, text: 'x'.repeat(40) },
      { text: 'x'.repeat(40) },
      { text: 'x'.repeat(40) },
    ];
    expect(planThinkingCompaction(turns, 100)).toEqual([1]);
  });
});

describe('renderThinking', () => {
  test('empty in, empty out — no bare block header', () => {
    expect(renderThinking([])).toBe('');
  });

  test('labels turns by age', () => {
    const block = renderThinking(['old', 'recent']);
    expect(block).toContain('[2 turns ago]');
    expect(block).toContain('[your previous turn]');
  });

  test('every turn keeps its tool results (no last-three cut)', () => {
    const block = renderThinking(
      Array.from({ length: 6 }, (_, index) => ({
        reasoning: `r${index}`,
        tools: `RESULTS-${index}`,
      }))
    );
    for (const index of [0, 1, 2, 3, 4, 5]) {
      expect(block).toContain(`RESULTS-${index}`);
    }
  });

  test('a summary comes first and is labelled as one', () => {
    const block = renderThinking([
      { reasoning: 'SUMMARY', summary: true },
      { reasoning: 'latest' },
    ]);
    expect(block.indexOf('SUMMARY')).toBeLessThan(block.indexOf('latest'));
    expect(block).toContain('[summary of your earlier turns here]');
  });

  test('an overflow that compaction missed drops the oldest, keeps the newest', () => {
    const block = renderThinking(
      [{ reasoning: big('OLD', 80) }, { reasoning: big('NEW', 80) }],
      100
    );
    expect(block).toContain('NEW');
    expect(block).not.toContain('OLD');
  });
});
