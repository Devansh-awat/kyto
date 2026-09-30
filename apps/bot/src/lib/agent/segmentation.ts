// When a turn cuts a new plan block. Split out of streamSegmented so the rule
// has tests: the IO around it (opening a Slack stream, flushing buffered reply
// text) is untestable without Slack, but the DECISION is a two-state machine and
// it has been wrong twice in ways users saw.

/**
 * Does this text fragment produce anything the user will actually see?
 *
 * Reply text is buffered by `createReply` and posted on blank-line boundaries,
 * and a whitespace-only buffer is never posted at all — so a whitespace fragment
 * must not count as "the model has replied". Models routinely emit `"\n"`
 * between tool calls, and treating those as text opened a new, empty
 * collapsible plan block for every stretch of tools: the "three plan blocks,
 * nothing written between them" bug.
 */
export function isVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

export type SegmentAction =
  /** Reply text: append it and keep the block open. */
  | 'append'
  /** A task card belonging to the block currently open. */
  | 'emit'
  /** A NEW task card arriving after visible reply text — end the block first. */
  | 'split';

/**
 * The per-block rule: task cards accumulate until visible reply text streams,
 * and the next task card after that ends the block. That is what produces
 * `[plan] text [plan] text` — the model can post an update and keep working in a
 * fresh block instead of one block growing all turn.
 *
 * An UPDATE to a card already in this block stays in it, text or not: a tool
 * called before the text and finishing after it (GLM writes its "let me check"
 * after the call) must finish HERE. Sent to the next block, it lands in a
 * `chatStream` with no such task, which Slack renders as a failed row under
 * "Something went wrong" — on every such turn in #kyto, 2026-09-30, while the
 * tools had all succeeded.
 *
 * Create one per block; `next` reports what the caller should do with each item.
 */
export function createSegmenter(): {
  next(
    value: string | { type?: string },
    options?: { inThisBlock?: boolean }
  ): SegmentAction;
  sawText(): boolean;
} {
  let sawVisibleText = false;
  return {
    next(value, options) {
      if (typeof value === 'string') {
        sawVisibleText ||= isVisibleText(value);
        return 'append';
      }
      return sawVisibleText && !options?.inThisBlock ? 'split' : 'emit';
    },
    sawText() {
      return sawVisibleText;
    },
  };
}
