import { describe, expect, test } from 'bun:test';
import { createCardBudget, overflowRow } from './cards';

const budget = () => createCardBudget({ maxReasoning: 2, maxTools: 3 });

function fill(
  cards: ReturnType<typeof budget>,
  kind: 'reasoning' | 'tool',
  count: number,
  offset = 0
): boolean[] {
  return Array.from({ length: count }, (_, index) =>
    cards.show({ id: `${kind}-${offset + index}`, kind, title: 'x' })
  );
}

describe('createCardBudget', () => {
  test('shows cards up to the limit, then hides them', () => {
    const cards = budget();
    expect(fill(cards, 'tool', 5)).toEqual([true, true, true, false, false]);
    expect(cards.hiddenCount('tool')).toBe(2);
  });

  test('tool activity cannot starve the reasoning budget', () => {
    // They shared one set once, so a turn full of tool calls hid every later
    // thinking block — the reasoning vanished on exactly the long turns where
    // it matters most.
    const cards = budget();
    fill(cards, 'tool', 10);
    expect(fill(cards, 'reasoning', 2)).toEqual([true, true]);
  });

  test('a finished card does not give its slot back', () => {
    // Otherwise a turn making one call at a time would never overflow and the
    // plan would grow without bound.
    const cards = budget();
    for (let at = 0; at < 3; at++) {
      cards.show({ id: `t${at}`, kind: 'tool', title: 'x' });
      cards.finish(`t${at}`);
    }
    expect(cards.show({ id: 't3', kind: 'tool', title: 'x' })).toBe(false);
  });

  test('re-showing a visible card is free', () => {
    const cards = budget();
    fill(cards, 'tool', 3);
    expect(cards.show({ id: 'tool-0', kind: 'tool', title: 'x' })).toBe(true);
    expect(cards.hiddenCount('tool')).toBe(0);
  });

  test('isVisible tells a result whether its request was rendered', () => {
    const cards = budget();
    fill(cards, 'tool', 4);
    expect(cards.isVisible('tool-0')).toBe(true);
    expect(cards.isVisible('tool-3')).toBe(false);
  });
});

describe('endMessage', () => {
  test('the budget starts over for the next plan message', () => {
    // THE bug this module exists for: the budget used to last a whole attempt,
    // while a turn is rendered across several plan messages. Every message
    // after the first could then only ever show "N more tool calls".
    const cards = budget();
    fill(cards, 'tool', 5);
    cards.endMessage();
    expect(fill(cards, 'tool', 3, 100)).toEqual([true, true, true]);
    expect(cards.hiddenCount('tool')).toBe(0);
  });

  test('completes every card still mid-flight', () => {
    // A card id only exists inside the message it was appended to, so one left
    // in_progress can never be updated again — and a collapsed plan renders a
    // non-terminal row as broken.
    const cards = budget();
    cards.show({ id: 'a', kind: 'tool', title: 'Reading a file' });
    cards.show({ id: 'b', kind: 'tool', title: 'Searching' });
    cards.finish('b');
    const closers = cards.endMessage();
    expect(closers).toEqual([
      {
        id: 'a',
        status: 'complete',
        title: 'Reading a file',
        type: 'task_update',
      },
    ]);
  });

  test('finalizes each overflow row it opened, and only those', () => {
    const cards = budget();
    fill(cards, 'tool', 4);
    for (let at = 0; at < 3; at++) {
      cards.finish(`tool-${at}`);
    }
    const closers = cards.endMessage();
    expect(closers).toEqual([
      overflowRow({ count: 1, done: true, kind: 'tool' }),
    ]);
  });

  test('says nothing when the message hid nothing and left nothing open', () => {
    const cards = budget();
    fill(cards, 'tool', 2);
    cards.finish('tool-0');
    cards.finish('tool-1');
    expect(cards.endMessage()).toEqual([]);
  });

  test('a card carried past a boundary is no longer visible', () => {
    // Its update would land in a message that has no such row, so the caller
    // must drop it rather than create a stray "complete" card out of nowhere.
    const cards = budget();
    cards.show({ id: 'a', kind: 'tool', title: 'x' });
    cards.endMessage();
    expect(cards.isVisible('a')).toBe(false);
  });
});

describe('overflowRow', () => {
  test('names the kind, so the two rows are never confused', () => {
    expect(overflowRow({ count: 3, done: true, kind: 'tool' }).title).toBe(
      '3 more tool calls'
    );
    expect(overflowRow({ count: 3, done: true, kind: 'reasoning' }).title).toBe(
      '3 more thinking steps'
    );
  });

  test('singular reads like English', () => {
    expect(overflowRow({ count: 1, done: false, kind: 'tool' }).title).toBe(
      '1 more tool call (running)'
    );
  });

  test('the two kinds keep separate card ids', () => {
    expect(overflowRow({ count: 1, done: true, kind: 'tool' }).id).not.toBe(
      overflowRow({ count: 1, done: true, kind: 'reasoning' }).id
    );
  });
});
