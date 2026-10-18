import { describe, expect, test } from 'bun:test';
import type { Message } from '@/harness/types';
import { addressedState, pingsSomeoneElse } from './addressed';

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
        message('owner', '<> <@U0KYTO> you too'),
        message('lily', '<@U0OTHER> build yours from scratch'),
      ],
      selfId: 'U0KYTO',
    });
    expect(state).toBe(
      'owner: <> @kyto you too\nlily: @U0OTHER build yours from scratch'
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

describe('pingsSomeoneElse', () => {
  const selfId = 'U0KYTO1';
  test('a follow-up pinging nobody, or only kyto, is not for someone else', () => {
    expect(
      pingsSomeoneElse({ selfId, text: 'why do agent reminders wait 10 mins' })
    ).toBe(false);
    expect(pingsSomeoneElse({ selfId, text: '<@U0KYTO1> also check X' })).toBe(
      false
    );
    expect(pingsSomeoneElse({ selfId, text: 'look at <#C028VGT0JMQ>' })).toBe(
      false
    );
  });
  test('pinging another person, bot, group or the channel is', () => {
    expect(
      pingsSomeoneElse({ selfId, text: '<@U0OTHER2> what do you think' })
    ).toBe(true);
    expect(
      pingsSomeoneElse({ selfId, text: '<@U0KYTO1> <@U0OTHER2> both of you' })
    ).toBe(true);
    expect(pingsSomeoneElse({ selfId, text: '<!subteam^S123> ping' })).toBe(
      true
    );
    expect(pingsSomeoneElse({ selfId, text: '<!here> look' })).toBe(true);
  });
});
