import { describe, expect, test } from 'bun:test';
import {
  allowBotTurn,
  MAX_BOT_TURNS_IN_A_ROW,
  noteHumanMessage,
} from './bot-pings';

function fill(thread: string): void {
  for (let i = 0; i < MAX_BOT_TURNS_IN_A_ROW; i += 1) {
    expect(allowBotTurn(thread, i)).toBe('allowed');
  }
}

describe('allowBotTurn', () => {
  test('fifty bot turns in a row, one stop notice, then silence', () => {
    const thread = 'slack:C1:1';
    fill(thread);
    expect(allowBotTurn(thread, 100)).toBe('stopped-now');
    expect(allowBotTurn(thread, 101)).toBe('stopped');
    expect(allowBotTurn(thread, 102)).toBe('stopped');
  });

  test('a person speaking resets the streak', () => {
    const thread = 'slack:C1:2';
    fill(thread);
    noteHumanMessage(thread);
    expect(allowBotTurn(thread, 200)).toBe('allowed');
  });

  test('a streak goes stale after a quiet window', () => {
    const thread = 'slack:C1:3';
    fill(thread);
    expect(allowBotTurn(thread, 16 * 60 * 1000)).toBe('allowed');
  });

  test('threads are counted separately', () => {
    fill('slack:C1:4');
    expect(allowBotTurn('slack:C1:5', 5)).toBe('allowed');
  });
});
