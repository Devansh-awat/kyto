import {
  computeNextRun,
  type Reminder,
  type ReminderKind,
  type ReminderSchedule,
} from '@repo/db/queries';
import { errorMessage } from '@/lib/utils/error';

// The rules every way of creating or editing a reminder enforces — the
// reminder tools and the App Home editor — so neither can be the loophole.

// How often each kind may fire, floored by what a fire actually costs.
// 'message'/'script' are a post and maybe an HTTP GET. 'bash' resumes a real
// sandbox. 'agent' runs a whole tool loop against a model.
const MIN_INTERVAL_SECONDS_DEFAULT = 60;
const MIN_INTERVAL_SECONDS_BASH = 5 * 60;
const MIN_INTERVAL_SECONDS_AGENT = 60 * 60;
export const MAX_INTERVAL_SECONDS = 180 * 24 * 60 * 60;
const MIN_INTERVAL_SECONDS_BY_KIND: Record<ReminderKind, number> = {
  agent: MIN_INTERVAL_SECONDS_AGENT,
  bash: MIN_INTERVAL_SECONDS_BASH,
  message: MIN_INTERVAL_SECONDS_DEFAULT,
  script: MIN_INTERVAL_SECONDS_DEFAULT,
};

export type Recurrence = 'interval' | 'daily' | 'weekly' | 'cron';

export interface ScheduleArgs {
  cron?: string;
  intervalSeconds?: number;
  recurrence?: Recurrence;
  timeOfDayMinutes?: number;
  timezone?: string;
  weekday?: number;
}

type ScheduleResult =
  | { ok: true; schedule: ReminderSchedule }
  | { ok: false; error: string };

export function buildSchedule(
  args: ScheduleArgs & { recurrence: Recurrence },
  kind: ReminderKind
): ScheduleResult {
  const { recurrence, intervalSeconds, timeOfDayMinutes, weekday } = args;
  if (recurrence === 'cron') {
    if (!args.cron) {
      return { error: "recurrence 'cron' requires cron.", ok: false };
    }
    const schedule: ReminderSchedule = {
      cronExpression: args.cron.trim(),
      recurrence: 'cron',
      timezone: args.timezone ?? 'UTC',
    };
    // The kind's floor holds for cron too: the gap between its next two fires
    // (a `* * * * *` agent job would otherwise run a model every minute).
    try {
      const first = computeNextRun(schedule, new Date());
      const second = computeNextRun(schedule, first);
      const gapSeconds = (second.getTime() - first.getTime()) / 1000;
      const floor = MIN_INTERVAL_SECONDS_BY_KIND[kind];
      if (gapSeconds < floor) {
        return {
          error: `kind '${kind}' can fire at most every ${floor} seconds; this cron fires ${gapSeconds}s apart.`,
          ok: false,
        };
      }
    } catch (error) {
      return {
        error: `Invalid cron schedule: ${errorMessage(error)}`,
        ok: false,
      };
    }
    return { ok: true, schedule };
  }
  if (recurrence === 'interval') {
    if (intervalSeconds === undefined) {
      return {
        error: "recurrence 'interval' requires intervalSeconds.",
        ok: false,
      };
    }
    // Each fire of a bash/agent reminder costs a sandbox resume or a model run,
    // so they are floored well above the 60s the schema allows.
    const floor = MIN_INTERVAL_SECONDS_BY_KIND[kind];
    if (intervalSeconds < floor) {
      return {
        error: `kind '${kind}' can fire at most every ${floor} seconds (got ${intervalSeconds}).`,
        ok: false,
      };
    }
    if (intervalSeconds > MAX_INTERVAL_SECONDS) {
      return {
        error: `An interval can be at most ${MAX_INTERVAL_SECONDS} seconds (180 days).`,
        ok: false,
      };
    }
    return { ok: true, schedule: { intervalSeconds, recurrence: 'interval' } };
  }
  if (recurrence === 'daily') {
    if (timeOfDayMinutes === undefined) {
      return {
        error: "recurrence 'daily' requires timeOfDayMinutes.",
        ok: false,
      };
    }
    return { ok: true, schedule: { recurrence: 'daily', timeOfDayMinutes } };
  }
  if (timeOfDayMinutes === undefined || weekday === undefined) {
    return {
      error: "recurrence 'weekly' requires timeOfDayMinutes and weekday.",
      ok: false,
    };
  }
  return {
    ok: true,
    schedule: { recurrence: 'weekly', timeOfDayMinutes, weekday },
  };
}

/**
 * Whether an edit changes what the reminder DOES, as opposed to when or how
 * often. A reminder always fires as the person who CREATED it — that is the only
 * principal available once the turn is long gone. So what a named EDITOR may
 * change stops short of what the job does: flipping a "remind me to stretch"
 * into an `agent` or `bash` reminder would run their instructions under the
 * creator's identity and permissions, on a timer, forever. An editor can
 * re-time it, retitle it and cap it; its kind, its command or its script URL
 * stay with the creator (and the bot owner). For an 'agent' reminder the TEXT
 * is the instruction it runs, so it is the creator's too.
 */
export function changesWhatReminderRuns({
  command,
  existing,
  kind,
  text,
  url,
}: {
  command?: string;
  existing: Pick<Reminder, 'command' | 'kind' | 'text' | 'url'>;
  kind?: ReminderKind;
  text?: string;
  url?: string;
}): boolean {
  return (
    (kind !== undefined && kind !== existing.kind) ||
    (command !== undefined && command !== existing.command) ||
    (url !== undefined && url !== existing.url) ||
    (text !== undefined &&
      text !== existing.text &&
      (kind ?? existing.kind) === 'agent')
  );
}
