import { describe, expect, test } from 'bun:test';
import { buildSchedule, changesWhatReminderRuns } from './rules';

const agentJob = {
  command: null,
  kind: 'agent' as const,
  text: 'write the ad',
  url: null,
};

describe('changesWhatReminderRuns', () => {
  test('re-sending the same values is not a change', () => {
    expect(
      changesWhatReminderRuns({
        existing: agentJob,
        kind: 'agent',
        text: 'write the ad',
      })
    ).toBe(false);
  });

  test("an agent job's instructions are what it runs", () => {
    expect(
      changesWhatReminderRuns({ existing: agentJob, text: 'something else' })
    ).toBe(true);
  });

  test("a message reminder's text is not", () => {
    expect(
      changesWhatReminderRuns({
        existing: { ...agentJob, kind: 'message' },
        text: 'new wording',
      })
    ).toBe(false);
  });
});

describe('buildSchedule', () => {
  test('an agent job is floored at an hour', () => {
    expect(
      buildSchedule({ intervalSeconds: 600, recurrence: 'interval' }, 'agent')
        .ok
    ).toBe(false);
  });

  test('an interval is capped at 180 days', () => {
    expect(
      buildSchedule(
        { intervalSeconds: 200 * 24 * 60 * 60, recurrence: 'interval' },
        'message'
      ).ok
    ).toBe(false);
  });

  test('a cron in a timezone builds', () => {
    expect(
      buildSchedule(
        { cron: '0 9 * * 1', recurrence: 'cron', timezone: 'Asia/Kolkata' },
        'agent'
      ).ok
    ).toBe(true);
  });
});
