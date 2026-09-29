// The small block kyto posts under a reply: how long the turn took, a note when
// the answer came from a weaker model than usual, and 👍/👎 feedback buttons.
//
// Tokens and tokens/second used to live here. They measured the provider, not
// the answer, and read as noise to everyone but the owner; "how long did I
// wait" is the number a person actually feels (owner's call, 2026-09-29).

export const FEEDBACK_UP_ACTION = 'reply_feedback_up';
export const FEEDBACK_DOWN_ACTION = 'reply_feedback_down';

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
export function fallbackNote({
  model,
  primaryLabel,
}: {
  model: string;
  primaryLabel: string;
}): string {
  return `${primaryLabel} couldn't answer this one, so \`${model}\` did. it's a weaker model, so this reply may be worse than usual.`;
}

type FooterBlock =
  | {
      elements: { text: string; type: 'mrkdwn' }[];
      type: 'context';
    }
  | {
      elements: {
        action_id: string;
        text: { emoji: true; text: string; type: 'plain_text' };
        type: 'button';
        value: string;
      }[];
      type: 'actions';
    };

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
  fallback?: { model: string; primaryLabel: string };
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
    const value = model ?? '';
    blocks.push({
      elements: [
        {
          action_id: FEEDBACK_UP_ACTION,
          text: { emoji: true, text: '👍', type: 'plain_text' },
          type: 'button',
          value,
        },
        {
          action_id: FEEDBACK_DOWN_ACTION,
          text: { emoji: true, text: '👎', type: 'plain_text' },
          type: 'button',
          value,
        },
      ],
      type: 'actions',
    });
  }
  return { blocks, fallbackText: lines.join('\n') || 'feedback' };
}
