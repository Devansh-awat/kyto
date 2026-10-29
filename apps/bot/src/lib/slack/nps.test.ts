import { describe, expect, test } from 'bun:test';
import { summarizeNps } from './nps';

// NPS is not an average: 7-8 count toward the total but neither side, and the
// bands meet at 6|7 and 8|9. An off-by-one there, or treating it as a mean,
// still produces a plausible-looking number.
describe('summarizeNps', () => {
  test('bands split at 6|7 and 8|9, passives dilute', () => {
    // promoters: 9, 10 · passives: 7, 8 · detractors: 0, 6 → (2-2)/6 = 0
    expect(summarizeNps([0, 6, 7, 8, 9, 10])).toMatchObject({
      detractors: 2,
      nps: 0,
      passives: 2,
      promoters: 2,
      responses: 6,
    });
  });

  test('asymmetric mix rounds the percentage', () => {
    // 2 promoters, 1 passive, 0 detractors of 3 → 66.7 → 67; average 9.0
    expect(summarizeNps([9, 10, 8])).toMatchObject({
      averageScore: 9,
      nps: 67,
    });
    // all detractors → -100
    expect(summarizeNps([3, 6]).nps).toBe(-100);
  });

  test('no responses is null, not zero', () => {
    expect(summarizeNps([])).toMatchObject({ averageScore: null, nps: null });
  });
});
