// The pure half of the thinking cache: which of the oldest turns are folded
// into a summary, and how it is rendered into the prompt. Split out of
// thinking.ts (which owns the Postgres IO, the token measurement and the model
// call) so these rules can be tested — they decide real money, because this
// block rides in EVERY turn's prompt. How MUCH is folded is decided from the
// provider's measured token count (compactThinking), never a char budget.

// Per-turn ceiling on the reasoning at the moment a turn is STORED, so one
// pathological turn can't take over the block.
export const MAX_TURN_CHARS = 20_000;

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
 * Which stored turns to fold into a summary so that at least `foldChars`
 * leave the block: the OLDEST first. The newest turn is never folded — it is
 * what "pick up where you left off" means — and a summary is never folded as
 * a turn (it is rewritten with the fold). Returns indexes into `turns`.
 */
export function planThinkingCompaction(
  turns: CompactableTurn[],
  foldChars: number
): number[] {
  const live = turns
    .map((turn, index) => ({ index, turn }))
    .filter(({ turn }) => !turn.summary);
  const folded: number[] = [];
  let removed = 0;
  for (const { index, turn } of live.slice(0, -1)) {
    if (removed >= foldChars) {
      break;
    }
    folded.push(index);
    removed += turnChars(turn);
  }
  return folded;
}

/**
 * The block buildPrompt injects: summaries first, then every kept turn whole,
 * oldest first. Its size is held by the measured token limit (the fold), not
 * here. Framed hard, because the failure mode of showing a model its own past
 * reasoning is that it narrates or re-litigates it.
 */
export function renderThinking(turns: (string | RecalledTurn)[]): string {
  const recalled = turns
    .map((turn) => (typeof turn === 'string' ? { reasoning: turn } : turn))
    .filter((turn) => turn.reasoning || turn.tools);
  const summaries = recalled.filter((turn) => turn.summary);
  const kept = recalled.filter((turn) => !turn.summary);
  if (recalled.length === 0) {
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
