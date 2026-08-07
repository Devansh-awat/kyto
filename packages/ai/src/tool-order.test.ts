import { describe, expect, test } from 'bun:test';
import { stabilizeToolOrder } from './tool-order';

const tool = (name: string) => ({
  function: { name, parameters: {} },
  type: 'function',
});

const names = (payload: Record<string, unknown>): string[] =>
  (payload.tools as { function: { name: string } }[]).map(
    (entry) => entry.function.name
  );

describe('stabilizeToolOrder', () => {
  test('records the first request order and changes nothing', () => {
    const state = { names: [] as string[] };
    const payload = { tools: [tool('a'), tool('b')] };
    expect(stabilizeToolOrder(payload, state)).toBe(false);
    expect(state.names).toEqual(['a', 'b']);
  });

  test('appends a tool that appears mid-turn instead of splicing it in', () => {
    // This is the whole point: `loadTools` makes `browser` visible, and the
    // toolset's own key order would put it between `a` and `b`, moving every
    // byte after it and losing the prompt cache for the rest of the turn.
    const state = { names: ['a', 'b'] };
    const payload = { tools: [tool('a'), tool('browser'), tool('b')] };
    expect(stabilizeToolOrder(payload, state)).toBe(true);
    expect(names(payload)).toEqual(['a', 'b', 'browser']);
    expect(state.names).toEqual(['a', 'b', 'browser']);
  });

  test('keeps the established order across several loads', () => {
    const state = { names: [] as string[] };
    const first = { tools: [tool('a'), tool('b')] };
    stabilizeToolOrder(first, state);
    const second = { tools: [tool('a'), tool('x'), tool('b')] };
    stabilizeToolOrder(second, state);
    const third = { tools: [tool('a'), tool('x'), tool('b'), tool('y')] };
    expect(stabilizeToolOrder(third, state)).toBe(true);
    expect(names(third)).toEqual(['a', 'b', 'x', 'y']);
  });

  test('drops a tool from the remembered order when it goes away', () => {
    const state = { names: ['a', 'b'] };
    const payload = { tools: [tool('b')] };
    stabilizeToolOrder(payload, state);
    expect(names(payload)).toEqual(['b']);
    expect(state.names).toEqual(['b']);
  });

  test('leaves a payload alone when a tool name cannot be read', () => {
    // Reordering a list we cannot fully identify risks dropping a tool, which
    // costs the model a capability; a lost cache only costs money.
    const state = { names: ['a'] };
    const unreadable = { type: 'function' };
    const payload = { tools: [tool('a'), unreadable] };
    expect(stabilizeToolOrder(payload, state)).toBe(false);
    expect(payload.tools[1]).toBe(unreadable);
    expect(state.names).toEqual(['a']);
  });

  test('ignores a request with no tools', () => {
    const state = { names: [] as string[] };
    expect(stabilizeToolOrder({}, state)).toBe(false);
    expect(stabilizeToolOrder({ tools: [] }, state)).toBe(false);
  });
});
