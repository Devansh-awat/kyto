import { describe, expect, test } from 'bun:test';
import { timeUntilUtcMidnight } from '@/lib/errors';

describe('timeUntilUtcMidnight', () => {
  test("counts to Hack Club's UTC reset, not London's, in summer time", () => {
    // 22:30 UTC is 23:30 in London (BST): London midnight would say 0h 30m.
    expect(timeUntilUtcMidnight(new Date('2026-10-14T22:30:00Z'))).toEqual({
      hours: 1,
      minutes: 30,
    });
  });

  test('rounds a part-minute up and rolls over at midnight', () => {
    expect(timeUntilUtcMidnight(new Date('2026-10-14T13:12:30Z'))).toEqual({
      hours: 10,
      minutes: 48,
    });
    expect(timeUntilUtcMidnight(new Date('2026-10-15T00:00:00Z'))).toEqual({
      hours: 24,
      minutes: 0,
    });
  });
});
