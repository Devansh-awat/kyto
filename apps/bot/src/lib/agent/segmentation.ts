// When a turn cuts a new message. Split out of streamSegmented so the rule has
// tests: the IO around it (opening a Slack stream) is untestable without Slack,
// but the DECISION is a small state machine and it has been wrong in ways users
// saw.

/**
 * Does this text fragment produce anything the user will actually see?
 *
 * A whitespace-only buffer is never posted at all (`createReply`), so a
 * whitespace fragment must not count as "the model has replied". Models routinely emit `"\n"`
 * between tool calls, and treating those as text opened a new, empty
 * collapsible plan block for every stretch of tools: the "three plan blocks,
 * nothing written between them" bug.
 */
export function isVisibleText(text: string): boolean {
  return text.trim().length > 0;
}

export type SegmentAction =
  /** Reply text that belongs in the message currently open. */
  | 'append'
  /** A task card for the message currently open. */
  | 'emit'
  /** Visible text after this message's cards — it opens the next message. */
  | 'split'
  /** An update to a card that lived in an EARLIER message. */
  | 'drop';

/**
 * Where a turn's output goes (owner's call 2026-10-13): reply text OPENS a
 * message, and the thinking and tool cards that follow it go into that same
 * message, under the text. Visible text arriving after a card ends the message
 * and starts the next one. So a turn reads `[Thinking]`, `text [cards]`,
 * `text [cards]`, … — not a plan message and a text message per step, which put
 * one answer into a pile of messages.
 *
 * Whitespace never splits: models emit `"\n"` between tool calls, and counting
 * that as text opened an empty message per stretch of tools.
 *
 * A card id only exists inside the message it was appended to, and the message
 * left behind has already settled its open cards (`cards.endMessage`). An update
 * for one of them arriving later (GLM writes its "let me check" after the call,
 * so the result lands after the split) is DROPPED: sent to the new message, it
 * becomes a row Slack renders as failed under "Something went wrong".
 *
 * One per turn; `newMessage` is called whenever a message is cut.
 */
export function createSegmenter(): {
  newMessage(): void;
  next(value: string | { id?: string; type?: string }): SegmentAction;
} {
  let sawCard = false;
  const thisMessage = new Set<string>();
  const earlier = new Set<string>();
  return {
    newMessage() {
      for (const id of thisMessage) {
        earlier.add(id);
      }
      thisMessage.clear();
      sawCard = false;
    },
    next(value) {
      if (typeof value === 'string') {
        return sawCard && isVisibleText(value) ? 'split' : 'append';
      }
      if (value.id !== undefined) {
        if (earlier.has(value.id) && !thisMessage.has(value.id)) {
          return 'drop';
        }
        thisMessage.add(value.id);
      }
      sawCard = true;
      return 'emit';
    },
  };
}
