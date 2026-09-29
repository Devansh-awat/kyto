import { describe, expect, test } from 'bun:test';
import { allowBotTurn, noteHumanMessage } from './bot-pings';

describe('allowBotTurn', () => {
  test('three bot turns in a row, then silence', () => {
    const thread = 'slack:C1:1';
    expect(allowBotTurn(thread, 0)).toBe(true);
    expect(allowBotTurn(thread, 1)).toBe(true);
    expect(allowBotTurn(thread, 2)).toBe(true);
    expect(allowBotTurn(thread, 3)).toBe(false);
  });

  test('a person speaking resets the streak', () => {
    const thread = 'slack:C1:2';
    for (let i = 0; i < 3; i += 1) {
      allowBotTurn(thread, i);
    }
    noteHumanMessage(thread);
    expect(allowBotTurn(thread, 10)).toBe(true);
  });

  test('a streak goes stale after a quiet window', () => {
    const thread = 'slack:C1:3';
    for (let i = 0; i < 3; i += 1) {
      allowBotTurn(thread, i);
    }
    expect(allowBotTurn(thread, 16 * 60 * 1000)).toBe(true);
  });

  test('threads are counted separately', () => {
    for (let i = 0; i < 3; i += 1) {
      allowBotTurn('slack:C1:4', i);
    }
    expect(allowBotTurn('slack:C1:5', 5)).toBe(true);
  });
});
