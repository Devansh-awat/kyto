// The small block kyto posts under a reply: how long the turn took, a note when
// the answer came from a weaker model than usual, and 👍/👎 feedback buttons.
//
// Tokens and tokens/second used to live here. They measured the provider, not
// the answer, and read as noise to everyone but the owner; "how long did I
// wait" is the number a person actually feels (owner's call, 2026-09-29).

// Slack's native feedback control (`context_actions` + `feedback_buttons`):
// two small thumb icons on one line, where the old `actions` row was a pair of
// full-size buttons that dwarfed a short reply. One action id for both; the
// value says which thumb, then the model that answered.
export const FEEDBACK_ACTION = 'reply_feedback';
// The full-size buttons' ids, still on every footer posted before the switch.
export const FEEDBACK_UP_ACTION = 'reply_feedback_up';
export const FEEDBACK_DOWN_ACTION = 'reply_feedback_down';

/** A feedback thumb's value: `up:<model>` / `down:<model>`. */
export function parseFeedbackValue(
  value: string | undefined
): { model?: string; rating: 'down' | 'up' } | null {
  const match = /^(up|down):(.*)$/s.exec(value ?? '');
  if (!match) {
    return null;
  }
  return {
    model: match[2] || undefined,
    rating: match[1] === 'up' ? 'up' : 'down',
  };
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** `12.3s` under a minute, `1m 5s` from there on. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
  const rest = whole % SECONDS_PER_MINUTE;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Said whenever the usual model could not answer and a different one did, so a
 * worse-than-usual reply comes with its reason instead of reading as kyto
 * getting dumber. Not shown for a person's own key or a deliberate upgrade —
 * neither of those is a step down.
 */
function fallbackNote({
  model,
  outage,
  primaryLabel,
}: {
  model: string;
  outage?: string;
  primaryLabel: string;
}): string {
  const why = outage ? ` (${outage.toLowerCase()})` : '';
  return `${primaryLabel} couldn't answer this one${why}, so \`${model}\` did. it's a weaker model, so this reply may be worse than usual.`;
}

type FooterBlock =
  | {
      elements: { text: string; type: 'mrkdwn' }[];
      type: 'context';
    }
  | {
      elements: {
        action_id: string;
        negative_button: FeedbackButton;
        positive_button: FeedbackButton;
        type: 'feedback_buttons';
      }[];
      type: 'context_actions';
    };

interface FeedbackButton {
  accessibility_label: string;
  text: { emoji: true; text: string; type: 'plain_text' };
  value: string;
}

/**
 * The footer message, or null when there is nothing to show. `showFooter` is the
 * person's App Home toggle and covers the timing and the buttons; the fallback
 * note ignores it, because it is about the answer's quality, not decoration.
 */
export function buildReplyFooter({
  durationMs,
  fallback,
  model,
  showFooter,
}: {
  durationMs: number;
  /** Set when the answer came from a fallback model. */
  fallback?: { model: string; outage?: string; primaryLabel: string };
  /** The model that answered, carried on the buttons for the feedback row. */
  model?: string;
  showFooter: boolean;
}): { blocks: FooterBlock[]; fallbackText: string } | null {
  if (!(showFooter || fallback)) {
    return null;
  }
  const lines: string[] = [];
  if (showFooter) {
    lines.push(`_done in ${formatDuration(durationMs)}_`);
  }
  if (fallback) {
    lines.push(`_${fallbackNote(fallback)}_`);
  }
  const blocks: FooterBlock[] = [];
  if (lines.length > 0) {
    blocks.push({
      elements: lines.map((text) => ({ text, type: 'mrkdwn' })),
      type: 'context',
    });
  }
  if (showFooter) {
    const answeredBy = model ?? '';
    blocks.push({
      elements: [
        {
          action_id: FEEDBACK_ACTION,
          negative_button: {
            accessibility_label: 'Say this reply was bad',
            text: { emoji: true, text: 'Bad response', type: 'plain_text' },
            value: `down:${answeredBy}`,
          },
          positive_button: {
            accessibility_label: 'Say this reply was good',
            text: { emoji: true, text: 'Good response', type: 'plain_text' },
            value: `up:${answeredBy}`,
          },
          type: 'feedback_buttons',
        },
      ],
      type: 'context_actions',
    });
  }
  return { blocks, fallbackText: lines.join('\n') || 'feedback' };
}
