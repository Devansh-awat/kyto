import { describe, expect, test } from 'bun:test';
import type { Message } from '@/harness/types';
import { addressedState } from './addressed';

function message(name: string, text: string, isBot = false): Message {
  return {
    attachments: [],
    author: { isBot, userId: name, userName: name },
    id: name,
    isMention: false,
    metadata: {},
    raw: {},
    text,
    threadId: 'slack:C1:1.0',
  };
}

describe('addressedState', () => {
  test('names kyto by its own id and leaves other pings as ids', () => {
    const state = addressedState({
      messages: [
        message('owner', '<> <@UKYTO> you too'),
        message('lily', '<@UGORKIE> build yours from scratch'),
      ],
      selfId: 'UKYTO',
    });
    expect(state).toBe(
      'owner: <> @kyto you too\nlily: @UGORKIE build yours from scratch'
    );
  });

  test('marks bots and keeps only the newest characters', () => {
    const state = addressedState({
      messages: [
        message('old', 'x'.repeat(7000)),
        message('kevin', 'hi', true),
      ],
      selfId: undefined,
    });
    expect(state.endsWith('kevin (bot): hi')).toBe(true);
    expect(state.length).toBe(6000);
  });
});
