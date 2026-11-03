import type { Reminder } from '@repo/db/queries';
import { mrkdwn, plainText } from '@/harness/views';
import type { SlackBlock, SlackModalView } from '@/types/views';

export const REMINDER_MODAL_CALLBACK = 'home_reminder_save';
const MAX_TEXT_CHARS = 3000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
const MINUTES_PER_HOUR = 60;

export const EVERY_UNITS = {
  cron: 'Custom cron expression',
  daily: 'Every day at a time',
  days: 'Every N days',
  hours: 'Every N hours',
  minutes: 'Every N minutes',
  weekly: 'Every week on a day',
} as const;
export type EveryUnit = keyof typeof EVERY_UNITS;
export const UNIT_SECONDS = {
  days: SECONDS_PER_DAY,
  hours: SECONDS_PER_HOUR,
  minutes: SECONDS_PER_MINUTE,
} as const;

const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// A daily or weekly time set here is saved as a cron in the person's own
// timezone, so it reads back as one.
const SIMPLE_CRON = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/;

const option = (value: string, text: string) => ({
  text: plainText(text),
  value,
});

const pad = (n: number): string => String(n).padStart(2, '0');

interface ScheduleForm {
  count?: number;
  cron?: string;
  time?: string;
  timezone: string;
  unit: EveryUnit;
  weekday?: number;
}

/** The existing schedule, as the modal's fields would express it. */
function scheduleForm(
  reminder: Reminder | undefined,
  timezone: string
): ScheduleForm {
  if (!reminder) {
    return { count: 1, timezone, unit: 'days' };
  }
  if (reminder.recurrence === 'interval') {
    const seconds = reminder.intervalSeconds ?? SECONDS_PER_DAY;
    for (const unit of ['days', 'hours', 'minutes'] as const) {
      if (seconds % UNIT_SECONDS[unit] === 0) {
        return { count: seconds / UNIT_SECONDS[unit], timezone, unit };
      }
    }
    return {
      count: Math.round(seconds / SECONDS_PER_MINUTE),
      timezone,
      unit: 'minutes',
    };
  }
  if (reminder.recurrence === 'daily' || reminder.recurrence === 'weekly') {
    const minutes = reminder.timeOfDayMinutes ?? 0;
    return {
      time: `${pad(Math.floor(minutes / MINUTES_PER_HOUR))}:${pad(minutes % MINUTES_PER_HOUR)}`,
      timezone: 'UTC',
      unit: reminder.recurrence,
      ...(reminder.recurrence === 'weekly'
        ? { weekday: reminder.weekday ?? 0 }
        : {}),
    };
  }
  const cron = reminder.cronExpression ?? '';
  const tz = reminder.timezone ?? 'UTC';
  const simple = SIMPLE_CRON.exec(cron);
  if (simple) {
    const [, minute, hour, day] = simple;
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    return day === '*'
      ? { time, timezone: tz, unit: 'daily' }
      : { time, timezone: tz, unit: 'weekly', weekday: Number(day) };
  }
  return { cron, timezone: tz, unit: 'cron' };
}

/**
 * Create or edit a recurring AGENT reminder from App Home (other kinds are
 * changed by asking kyto; owner's call 2026-11-03). `mayChangeRuns` is false for
 * a named editor: an agent job's instructions are what it runs, and it runs as
 * its creator, so they show read-only.
 */
const AS_USER_APPROVALS = {
  ask: 'Ask me each time (a DM to approve)',
  next: 'Next run only, then ask',
  always: 'Every run, without asking',
} as const;

export function buildReminderModal({
  existing,
  isCreator,
  mayChangeRuns,
  timezone,
}: {
  existing?: Reminder;
  /** Only the creator may lend the job their own Slack account. */
  isCreator: boolean;
  mayChangeRuns: boolean;
  timezone: string;
}): SlackModalView {
  const blocks: SlackBlock[] = [];
  if (mayChangeRuns) {
    blocks.push({
      block_id: 'reminder_text',
      element: {
        action_id: 'text',
        ...(existing ? { initial_value: existing.text } : {}),
        max_length: MAX_TEXT_CHARS,
        multiline: true,
        placeholder: plainText(
          'e.g. Summarise yesterday’s messages in #general in three bullets.'
        ),
        type: 'plain_text_input',
      },
      hint: plainText(
        'kyto follows these on every run, with its full toolset; only its reply is posted.'
      ),
      label: plainText('Instructions'),
      type: 'input',
    });
  } else {
    blocks.push({
      text: mrkdwn(
        '*Instructions:* only the creator can change them — the job runs with their permissions.'
      ),
      type: 'section',
    });
  }

  if (existing?.recurrence === 'event') {
    blocks.push({
      elements: [
        mrkdwn(
          'This reminder fires on an event, not a schedule. Ask kyto to change what triggers it.'
        ),
      ],
      type: 'context',
    });
  } else {
    const form = scheduleForm(existing, timezone);
    blocks.push(
      { type: 'divider' },
      {
        block_id: 'reminder_every',
        element: {
          action_id: 'every',
          initial_option: option(form.unit, EVERY_UNITS[form.unit]),
          options: Object.entries(EVERY_UNITS).map(([value, text]) =>
            option(value, text)
          ),
          type: 'static_select',
        },
        hint: plainText('At most once an hour: every run is a real model run.'),
        label: plainText('How often'),
        type: 'input',
      },
      {
        block_id: 'reminder_count',
        element: {
          action_id: 'count',
          ...(form.count === undefined
            ? {}
            : { initial_value: String(form.count) }),
          is_decimal_allowed: false,
          min_value: '1',
          type: 'number_input',
        },
        hint: plainText('For “Every N minutes / hours / days”.'),
        label: plainText('N'),
        optional: true,
        type: 'input',
      },
      {
        block_id: 'reminder_time',
        element: {
          action_id: 'time',
          ...(form.time ? { initial_time: form.time } : {}),
          type: 'timepicker',
        },
        hint: plainText(
          'For “Every day” and “Every week”, in the timezone below.'
        ),
        label: plainText('At'),
        optional: true,
        type: 'input',
      },
      {
        block_id: 'reminder_weekday',
        element: {
          action_id: 'weekday',
          ...(form.weekday === undefined
            ? {}
            : {
                initial_option: option(
                  String(form.weekday),
                  WEEKDAY_LABELS[form.weekday] ?? 'Sunday'
                ),
              }),
          options: WEEKDAY_LABELS.map((label, index) =>
            option(String(index), label)
          ),
          type: 'static_select',
        },
        hint: plainText('For “Every week”.'),
        label: plainText('On'),
        optional: true,
        type: 'input',
      },
      {
        block_id: 'reminder_cron',
        element: {
          action_id: 'cron',
          ...(form.cron ? { initial_value: form.cron } : {}),
          placeholder: plainText('0 9 * * 1-5  (9:00 on weekdays)'),
          type: 'plain_text_input',
        },
        hint: plainText(
          'For “Custom cron”: minute hour day-of-month month day-of-week.'
        ),
        label: plainText('Cron'),
        optional: true,
        type: 'input',
      },
      {
        block_id: 'reminder_timezone',
        element: {
          action_id: 'timezone',
          initial_value: form.timezone,
          type: 'plain_text_input',
        },
        hint: plainText('An IANA name like Asia/Kolkata or America/New_York.'),
        label: plainText('Timezone'),
        type: 'input',
      }
    );
  }

  blocks.push(
    { type: 'divider' },
    {
      block_id: 'reminder_channel',
      element: {
        action_id: 'channel',
        ...(existing?.channelId
          ? { initial_conversation: existing.channelId }
          : {}),
        filter: { exclude_bot_users: true, include: ['public', 'private'] },
        type: 'conversations_select',
      },
      hint: plainText(
        'A channel you and kyto are both in. Leave empty to post in a DM to the creator.'
      ),
      label: plainText('Post in'),
      optional: true,
      type: 'input',
    }
  );
  blocks.push({
    block_id: 'reminder_max_runs',
    element: {
      action_id: 'max_runs',
      ...(existing?.maxRuns ? { initial_value: String(existing.maxRuns) } : {}),
      is_decimal_allowed: false,
      min_value: '1',
      type: 'number_input',
    },
    hint: plainText(
      existing
        ? `Stop after this many runs in total (it has run ${existing.runCount}). Empty = forever.`
        : 'Stop after this many runs. Empty = forever.'
    ),
    label: plainText('Run cap'),
    optional: true,
    type: 'input',
  });
  if (mayChangeRuns) {
    blocks.push({
      block_id: 'reminder_editors',
      element: {
        action_id: 'editors',
        ...(existing?.editorUserIds?.length
          ? { initial_users: existing.editorUserIds }
          : {}),
        type: 'multi_users_select',
      },
      hint: plainText(
        'They can change the wording and the schedule, never what it runs.'
      ),
      label: plainText('Also editable by'),
      optional: true,
      type: 'input',
    });
  }

  if (isCreator) {
    const current = existing?.asUserApproval ?? 'ask';
    blocks.push({
      block_id: 'reminder_as_user',
      element: {
        action_id: 'as_user',
        initial_option: option(current, AS_USER_APPROVALS[current]),
        options: Object.entries(AS_USER_APPROVALS).map(([value, text]) =>
          option(value, text)
        ),
        type: 'static_select',
      },
      hint: plainText(
        'When the job sends, edits or deletes a message from YOUR Slack account (connect it in App Home). Only you see this setting.'
      ),
      label: plainText('May act as you'),
      type: 'input',
    });
  }

  return {
    blocks,
    callback_id: REMINDER_MODAL_CALLBACK,
    close: plainText('Cancel'),
    ...(existing
      ? { private_metadata: JSON.stringify({ id: existing.id }) }
      : {}),
    submit: plainText('Save'),
    title: plainText(existing ? 'Edit agent job' : 'New agent job'),
    type: 'modal',
  };
}
