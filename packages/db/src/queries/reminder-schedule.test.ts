import { describe, expect, test } from 'bun:test';
import { computeNextRun } from './reminder-schedule';

describe('computeNextRun cron', () => {
  test('reads the expression in its timezone', () => {
    const next = computeNextRun(
      {
        cronExpression: '0 9 * * 1-5',
        recurrence: 'cron',
        timezone: 'Asia/Kolkata',
      },
      new Date('2026-10-08T00:00:00Z')
    );
    // 09:00 IST on a Thursday is 03:30 UTC.
    expect(next.toISOString()).toBe('2026-10-08T03:30:00.000Z');
  });

  test('skips the weekend for a weekdays-only expression', () => {
    const next = computeNextRun(
      { cronExpression: '0 9 * * 1-5', recurrence: 'cron', timezone: 'UTC' },
      new Date('2026-10-09T10:00:00Z')
    );
    expect(next.toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });

  test('a bad expression or timezone throws', () => {
    expect(() =>
      computeNextRun(
        { cronExpression: 'not cron', recurrence: 'cron', timezone: 'UTC' },
        new Date()
      )
    ).toThrow();
    expect(() =>
      computeNextRun(
        {
          cronExpression: '0 9 * * *',
          recurrence: 'cron',
          timezone: 'Nope/Zone',
        },
        new Date()
      )
    ).toThrow();
  });
});
