// Which plan cards are visible, and how many were folded into an overflow row.
//
// Split out of renderStream because the budget is PER PLAN MESSAGE and
// renderStream is not: one attempt's stream is rendered across several Slack
// messages, and only the consumer knows where one ends. A turn is cut into a
// new plan message twice over —
//
//   1. `streamSegmented` starts a fresh `slack.stream()` every time reply text
//      is followed by another task card ([plan] text [plan] text), and
//   2. `harness.stream` rotates to a fresh `chatStream` every STREAM_ROTATE_MS,
//      because Slack stops accepting appends after ~5 minutes.
//
// The budget used to be two `Set`s living inside renderStream for the whole
// attempt. So a long turn spent all 45 tool slots inside its FIRST plan message
// and every message after that could only ever render the overflow row: the
// owner saw a block with a Thinking card, no tool cards at all, and a bare
// "38 more tool calls" — for a month, on every long turn. A card id also only
// exists inside the `chatStream` it was appended to, so an update sent after a
// boundary lands in a message that has no such card.
//
// Hence: the caller owns the budget and calls `endMessage()` at every boundary.
// That both resets the counters for the new message and returns the chunks the
// OLD message still owes — a `complete` for every card left mid-flight, since a
// plan message stopped with a non-terminal row renders that row as broken once
// it collapses.

import type { StreamChunk } from '@/harness';

// NO CAP (owner's call, 2026-08-09: "i want ZERO budget"). Every tool call and
// every thinking block gets its own row, however long the turn runs.
//
// There used to be 45 of each. It was only ever a readability guess — Slack has
// no documented per-message card limit — and it cost the thing people actually
// want from the plan: seeing what kyto did. A turn that hid its work behind
// "38 more tool calls" was the single most-reported annoyance with the UI.
//
// The overflow machinery below is KEPT, not deleted: a caller can still pass a
// limit (and the tests exercise one), so re-capping is a one-line change if a
// real Slack ceiling ever turns up. What changed is the default.
export const MAX_VISIBLE_TOOL_CARDS = Number.POSITIVE_INFINITY;
export const MAX_VISIBLE_REASONING_CARDS = Number.POSITIVE_INFINITY;

export type CardKind = 'reasoning' | 'tool';

/** The plan-card half of StreamChunk — everything this module emits. */
type TaskCard = Extract<StreamChunk, { type: 'task_update' }>;

interface OpenCard {
  kind: CardKind;
  title: string;
}

type PerKind = Record<CardKind, number>;

const noneYet = (): PerKind => ({ reasoning: 0, tool: 0 });

/**
 * The overflow row for one kind. It is read by people scrolling a Slack thread,
 * not by us reading a log, so it says what it means: "Activity: 25 / Ran 25
 * additional activity items" told nobody anything and looked like a bug in a
 * turn that had gone fine.
 *
 * Two rows, never one: a shared counter mixed hidden tool calls with hidden
 * thinking blocks, and the owner read the result as kyto narrating step counts
 * instead of reasoning.
 */
export function overflowRow({
  count,
  done,
  kind,
}: {
  count: number;
  done: boolean;
  kind: CardKind;
}): TaskCard {
  const noun =
    kind === 'tool'
      ? `tool call${count === 1 ? '' : 's'}`
      : `thinking step${count === 1 ? '' : 's'}`;
  return {
    id: kind === 'tool' ? 'hidden-activity' : 'hidden-reasoning',
    output: done
      ? `${count} more ${noun} ran and are not shown individually, to keep this list readable.`
      : undefined,
    status: done ? 'complete' : 'in_progress',
    title: done ? `${count} more ${noun}` : `${count} more ${noun} (running)`,
    type: 'task_update',
  };
}

export function createCardBudget({
  maxReasoning = MAX_VISIBLE_REASONING_CARDS,
  maxTools = MAX_VISIBLE_TOOL_CARDS,
}: {
  maxReasoning?: number;
  maxTools?: number;
} = {}) {
  // Cards rendered into the CURRENT plan message, the ones among them still
  // mid-flight, and how many were folded into an overflow row instead.
  let shown = new Set<string>();
  let open = new Map<string, OpenCard>();
  let claimed = noneYet();
  let hidden = noneYet();

  const limit = (kind: CardKind) => (kind === 'tool' ? maxTools : maxReasoning);

  return {
    /**
     * Claim a slot for a card that is starting. Returns false when this message
     * is full, in which case the caller renders `overflow(kind)` instead.
     *
     * Counted by slots CLAIMED, not by cards currently open: a finished card
     * must not give its slot back, or a turn that makes one call at a time
     * would never overflow and the plan would grow without bound.
     */
    show({
      id,
      kind,
      title,
    }: {
      id: string;
      kind: CardKind;
      title: string;
    }): boolean {
      if (shown.has(id)) {
        return true;
      }
      if (claimed[kind] >= limit(kind)) {
        hidden[kind] += 1;
        return false;
      }
      claimed[kind] += 1;
      shown.add(id);
      open.set(id, { kind, title });
      return true;
    },
    /** Whether this card was rendered into the CURRENT plan message. */
    isVisible(id: string): boolean {
      return shown.has(id);
    },
    /** This card reached a terminal status, so it no longer needs closing. */
    finish(id: string): void {
      open.delete(id);
    },
    /** How many of `kind` were hidden in this message so far. */
    hiddenCount(kind: CardKind): number {
      return hidden[kind];
    },
    /** The running overflow row, for a card that could not be shown. */
    overflow(kind: CardKind): TaskCard {
      return overflowRow({ count: hidden[kind], done: false, kind });
    },
    /**
     * End the current plan message and start a fresh budget for the next one.
     *
     * Returns everything the message being closed still owes: a `complete` for
     * every card left mid-flight, then a finished overflow row for each kind
     * that hid anything. The caller must append these BEFORE the underlying
     * `chatStream` is stopped.
     */
    endMessage(): TaskCard[] {
      const chunks: TaskCard[] = [];
      for (const [id, card] of open) {
        chunks.push({
          id,
          status: 'complete',
          title: card.title,
          type: 'task_update',
        });
      }
      for (const kind of ['tool', 'reasoning'] as const) {
        if (hidden[kind] > 0) {
          chunks.push(overflowRow({ count: hidden[kind], done: true, kind }));
        }
      }
      shown = new Set();
      open = new Map();
      claimed = noneYet();
      hidden = noneYet();
      return chunks;
    },
  };
}

export type CardBudget = ReturnType<typeof createCardBudget>;
