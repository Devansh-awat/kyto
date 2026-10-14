import { describe, expect, test } from 'bun:test';
import type { Message } from '@/harness/types';
import { isHiddenFromBot } from '@/lib/utils/message';

function message(text: string): Message {
  return {
    attachments: [],
    author: { userId: 'U1', userName: 'someone' },
    id: '1.0',
    isMention: false,
    metadata: {},
    raw: { text },
    text,
    threadId: 'slack:C1:1.0',
  };
}

describe('isHiddenFromBot', () => {
  test('hides a message starting with ##', () => {
    expect(isHiddenFromBot(message('## im here'))).toBe(true);
    expect(isHiddenFromBot(message('<@U0BD3555UCQ> ##lol'))).toBe(true);
  });

  test('hides ## wrapped in Slack formatting', () => {
    expect(isHiddenFromBot(message('~## i wonder who did it~'))).toBe(true);
    expect(isHiddenFromBot(message('*## loud aside*'))).toBe(true);
    expect(isHiddenFromBot(message('_~##lol~_'))).toBe(true);
    expect(isHiddenFromBot(message('~not hidden~ ##'))).toBe(false);
  });

  test('hides ## that Slack turned into a channel link', () => {
    expect(isHiddenFromBot(message('#<#G0123ABCDE9>'))).toBe(true);
    expect(isHiddenFromBot(message('#<#C0B7QEK0MQB|general> hi'))).toBe(true);
  });

  test('keeps a plain channel link and a heading further down', () => {
    expect(isHiddenFromBot(message('<#C0B7QEK0MQB> is where'))).toBe(false);
    expect(isHiddenFromBot(message('#1 thing'))).toBe(false);
    expect(isHiddenFromBot(message('hi\n## heading'))).toBe(false);
  });
});
