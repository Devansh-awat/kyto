import { describe, expect, test } from 'bun:test';
import { type BoardElement, mergeElements } from './merge';

function element(
  id: string,
  version: number,
  extra: Partial<BoardElement> = {}
): BoardElement {
  return { id, version, versionNonce: 1, ...extra };
}

describe('mergeElements', () => {
  test('takes an element nobody has seen', () => {
    const board = new Map<string, BoardElement>();
    expect(mergeElements({ board, incoming: [element('a', 1)] })).toHaveLength(
      1
    );
    expect(board.get('a')?.version).toBe(1);
  });

  test('takes the higher version and ignores the older one', () => {
    const board = new Map([['a', element('a', 5)]]);
    expect(mergeElements({ board, incoming: [element('a', 4)] })).toEqual([]);
    expect(board.get('a')?.version).toBe(5);
    mergeElements({ board, incoming: [element('a', 6)] });
    expect(board.get('a')?.version).toBe(6);
  });

  test('breaks a tie the same way on every peer', () => {
    // Two people edit the same shape in the same instant, so both copies carry
    // the same version. Whoever's message lands second must NOT simply win, or
    // the two browsers keep different shapes forever.
    const left = new Map([['a', element('a', 3, { versionNonce: 10 })]]);
    const right = new Map([['a', element('a', 3, { versionNonce: 99 })]]);
    mergeElements({
      board: left,
      incoming: [element('a', 3, { versionNonce: 99 })],
    });
    mergeElements({
      board: right,
      incoming: [element('a', 3, { versionNonce: 10 })],
    });
    expect(left.get('a')?.versionNonce).toBe(99);
    expect(right.get('a')?.versionNonce).toBe(99);
  });

  test('a delete is kept as a record, not a removal', () => {
    // Erasing the element would let a peer holding the older copy put it back.
    const board = new Map([['a', element('a', 1)]]);
    mergeElements({
      board,
      incoming: [element('a', 2, { isDeleted: true })],
    });
    expect(board.get('a')?.isDeleted).toBe(true);
    mergeElements({ board, incoming: [element('a', 1)] });
    expect(board.get('a')?.isDeleted).toBe(true);
  });

  test('reports only what changed, so a resend costs nothing', () => {
    const board = new Map([['a', element('a', 2)]]);
    const applied = mergeElements({
      board,
      incoming: [element('a', 2), element('b', 1)],
    });
    expect(applied.map((entry) => entry.id)).toEqual(['b']);
  });

  test('skips junk instead of throwing on it', () => {
    // The socket is public: anything can be sent down it.
    const board = new Map<string, BoardElement>();
    const applied = mergeElements({
      board,
      incoming: [
        { id: 42 } as unknown as BoardElement,
        null as unknown as BoardElement,
        element('a', 1),
      ],
    });
    expect(applied.map((entry) => entry.id)).toEqual(['a']);
  });
});
