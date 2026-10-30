import { neutralizeBroadcast } from '@/harness/markdown';
import { askedByLine } from './poll';

const NPS_SCORE_ACTION = 'nps_score';
const MAX_SCORE = 10;
const PROMOTER_MIN = 9;
const PASSIVE_MIN = 7;
const DAY_MS = 86_400_000;

export const NPS_COMMENT_CALLBACK = 'nps_comment_submit';
export const NPS_COMMENT_BLOCK = 'nps_comment';
export const DEFAULT_NPS_QUESTION =
  'On a scale of 0-10, how likely are you to recommend this to a friend?';

// Slack requires every action_id in a message to be unique, so each score gets
// its own; the handler is registered for all eleven.
export const NPS_SCORE_ACTIONS = Array.from(
  { length: MAX_SCORE + 1 },
  (_, score) => `${NPS_SCORE_ACTION}_${score}`
);

export function scoreFromActionId(actionId: string): number | undefined {
  const score = NPS_SCORE_ACTIONS.indexOf(actionId);
  return score === -1 ? undefined : score;
}

export interface NpsSummary {
  averageScore: number | null;
  detractors: number;
  /** Promoters % minus detractors %, -100..100; null with no responses. */
  nps: number | null;
  passives: number;
  promoters: number;
  responses: number;
}

/**
 * The standard Net Promoter Score: 9-10 promoters, 7-8 passives, 0-6
 * detractors, and the score is %promoters - %detractors. Passives count toward
 * the total but neither side, which is what makes it differ from an average.
 */
export function summarizeNps(scores: number[]): NpsSummary {
  const promoters = scores.filter((score) => score >= PROMOTER_MIN).length;
  const passives = scores.filter(
    (score) => score >= PASSIVE_MIN && score < PROMOTER_MIN
  ).length;
  const detractors = scores.length - promoters - passives;
  const total = scores.length;
  return {
    averageScore:
      total === 0
        ? null
        : Math.round((scores.reduce((sum, s) => sum + s, 0) / total) * 10) / 10,
    detractors,
    nps:
      total === 0 ? null : Math.round(((promoters - detractors) / total) * 100),
    passives,
    promoters,
    responses: total,
  };
}

export function isNpsClosed(
  survey: { closedAt: Date | null; closesAt: Date },
  now = new Date()
): boolean {
  return survey.closedAt !== null || survey.closesAt <= now;
}

function closeLine(survey: { closedAt: Date | null; closesAt: Date }): string {
  if (isNpsClosed(survey)) {
    return '🔒 Closed';
  }
  const unix = Math.floor(survey.closesAt.getTime() / 1000);
  const days = Math.ceil((survey.closesAt.getTime() - Date.now()) / DAY_MS);
  return `Closes <!date^${unix}^{date_short_pretty}|in ${days} day${days === 1 ? '' : 's'}>`;
}

/**
 * The card shows only how many answered, never the score: a live number
 * nudges the people who haven't answered yet. The results go to whoever asks
 * kyto (the `npsResults` tool), and to everyone once it closes.
 */
export function buildNpsBlocks({
  askedBy,
  responses,
  survey,
}: {
  /** Display name of whoever started it. */
  askedBy?: string;
  responses: { score: number }[];
  survey: {
    closedAt: Date | null;
    closesAt: Date;
    id: number;
    question: string;
  };
}) {
  // Posted with chat.postMessage directly, so it never passes
  // ThreadHandle.post's broadcast strip; the question is model text.
  const question = neutralizeBroadcast(survey.question);
  const closed = isNpsClosed(survey);
  const count = `${responses.length} response${responses.length === 1 ? '' : 's'}`;
  const header = {
    text: {
      emoji: true,
      text: `📣  ${question}`.slice(0, 150),
      type: 'plain_text',
    },
    type: 'header',
  };

  if (closed) {
    const summary = summarizeNps(responses.map((r) => r.score));
    const result =
      summary.nps === null
        ? 'No responses.'
        : `*NPS ${summary.nps > 0 ? '+' : ''}${summary.nps}* · ${count} · ${summary.promoters} promoters, ${summary.passives} passives, ${summary.detractors} detractors`;
    return [
      header,
      { text: { text: result, type: 'mrkdwn' }, type: 'section' },
      {
        elements: [
          {
            text: `${closeLine(survey)}${askedByLine(askedBy)}`,
            type: 'mrkdwn',
          },
        ],
        type: 'context',
      },
    ];
  }

  const button = (score: number) => ({
    action_id: `${NPS_SCORE_ACTION}_${score}`,
    text: { text: String(score), type: 'plain_text' as const },
    type: 'button' as const,
    value: String(survey.id),
  });
  return [
    header,
    {
      elements: [0, 1, 2, 3, 4, 5].map(button),
      type: 'actions',
    },
    {
      elements: [6, 7, 8, 9, 10].map(button),
      type: 'actions',
    },
    {
      elements: [
        {
          text: `0 = not at all likely · 10 = extremely likely · click again to change · ${count} · ${closeLine(survey)}${askedByLine(askedBy)}`,
          type: 'mrkdwn',
        },
      ],
      type: 'context',
    },
  ];
}
