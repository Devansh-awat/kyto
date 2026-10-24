// The pure half of the thinking cache: what of each past turn is carried, when
// the oldest turns are folded into a summary, and how it is rendered into the
// prompt. Split out of thinking.ts (which owns the Postgres IO and the model
// call) so these rules can be tested — they decide real money, because this
// block rides in EVERY turn's prompt.

// The whole block's ceiling, reasoning AND tool results. ~60k chars ≈ 15k
// tokens: past it the oldest turns are folded into a summary
// (planThinkingCompaction) instead of being dropped.
export const THINKING_BUDGET_CHARS = 60_000;

// Per-turn ceiling on the reasoning at the moment a turn is STORED, so one
// pathological turn can't eat the whole budget.
export const MAX_TURN_CHARS = 20_000;

// A summary of the folded turns is held to this.
export const SUMMARY_MAX_CHARS = 8000;

// Compaction folds back down to this share of the budget, so it runs once per
// few turns rather than on every turn that crosses the line.
const COMPACT_TARGET_SHARE = 0.5;

/**
 * Keep the last `max` chars. Truncation is from the FRONT on purpose: a turn's
 * tail is where it worked out what was going on. The marker tells the model
 * "you are seeing the end of it", not "this turn was short".
 */
export function tail(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `[…earlier detail from this turn has been dropped]\n${text.slice(-max)}`;
}

/** A recalled turn: its reasoning and tool results, or a folded summary. */
export interface RecalledTurn {
  reasoning: string;
  /** A summary of turns folded away by compaction, not one turn. */
  summary?: boolean;
  tools?: string;
}

/** The fields compaction looks at on a stored turn. */
export interface CompactableTurn {
  privateTo?: string;
  summary?: boolean;
  text: string;
  tools?: string;
}

const turnChars = (turn: { text: string; tools?: string }): number =>
  turn.text.length + (turn.tools?.length ?? 0);

/**
 * Which stored turns to fold into a summary. Nothing until the replayed turns
 * pass `budget`; then the OLDEST turns go, until what is left (summaries
 * included) is back under half of it. The newest turn is never folded — it is
 * what "pick up where you left off" means. Returns indexes into `turns`.
 */
export function planThinkingCompaction(
  turns: CompactableTurn[],
  budget: number = THINKING_BUDGET_CHARS
): number[] {
  const total = turns.reduce((sum, turn) => sum + turnChars(turn), 0);
  if (total <= budget) {
    return [];
  }
  const target = budget * COMPACT_TARGET_SHARE;
  const live = turns
    .map((turn, index) => ({ index, turn }))
    .filter(({ turn }) => !turn.summary);
  const folded: number[] = [];
  let left = total;
  for (const { index, turn } of live.slice(0, -1)) {
    if (left <= target) {
      break;
    }
    folded.push(index);
    // The fold is replaced by (at most) a summary of this size.
    left -= turnChars(turn);
  }
  return folded;
}

/**
 * The block buildPrompt injects. Turns go in whole, oldest first, summaries
 * ahead of them. Compaction keeps the total near the budget; if it failed and
 * the turns overflow anyway, the oldest are left out (the newest always
 * stays, tail-clamped). Framed hard, because the failure mode of showing a
 * model its own past reasoning is that it narrates or re-litigates it.
 */
export function renderThinking(
  turns: (string | RecalledTurn)[],
  budget: number = THINKING_BUDGET_CHARS
): string {
  const recalled = turns
    .map((turn) => (typeof turn === 'string' ? { reasoning: turn } : turn))
    .filter((turn) => turn.reasoning || turn.tools);
  const summaries = recalled.filter((turn) => turn.summary);
  const live = recalled.filter((turn) => !turn.summary);
  let used = summaries.reduce((sum, turn) => sum + turn.reasoning.length, 0);
  const kept: RecalledTurn[] = [];
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const turn = live[index];
    if (!turn) {
      continue;
    }
    const cost = turn.reasoning.length + (turn.tools?.length ?? 0);
    if (kept.length > 0 && used + cost > budget) {
      break;
    }
    kept.unshift(
      kept.length === 0 && cost > budget
        ? { reasoning: tail(turn.reasoning, budget) }
        : turn
    );
    used += cost;
  }
  if (summaries.length === 0 && kept.length === 0) {
    return '';
  }
  const rendered = [
    ...summaries.map(
      (turn) => `[summary of your earlier turns here]\n${turn.reasoning}`
    ),
    ...kept.map((turn, index) => {
      const ago = kept.length - index;
      const label = ago === 1 ? 'your previous turn' : `${ago} turns ago`;
      return [
        `[${label}]`,
        turn.reasoning,
        turn.tools ? `[what your tools returned that turn]\n${turn.tools}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }),
  ];
  return [
    '<your_previous_thinking>',
    'Your own private reasoning AND what your tools returned in earlier turns in THIS thread, oldest first. Nobody in Slack can see it: Slack only kept what you said out loud, so this is the only way you still have your train of thought and the facts your tools uncovered (a value you computed, a file you wrote, a captcha you decoded) but never typed into a message.',
    'Every turn keeps its tool calls and results; the oldest turns are folded into a summary once this grows long. A summary or a cut tool result is abbreviated: if you need detail it dropped, re-run the tool or re-read the file rather than guessing at it.',
    'Use it to pick up where you left off: what you already tried, ruled out, were part-way through, or found. Do NOT narrate it, quote it, or apologise for it: it is a memory, not something the user said.',
    '',
    ...rendered,
    '</your_previous_thinking>',
  ].join('\n');
}
