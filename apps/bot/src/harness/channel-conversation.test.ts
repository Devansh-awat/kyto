import { describe, expect, test } from 'bun:test';
import { createLogger } from '@repo/logging/logger';
import { SlackHarness } from './harness';

const harness = new SlackHarness({
  botToken: 'xoxb-test',
  logger: await createLogger({ isProduction: true, logLevel: 'error' }),
});
harness.isChannelConversation = (channel) => channel === 'C0NATIVE0';
const author = { userId: 'U1', userName: 'someone' };

describe('a channel that is one conversation', () => {
  test('a top-level message belongs to the channel', () => {
    const message = harness.buildMessage(
      { channel: 'C0NATIVE0', text: 'hi', ts: '1.000100' },
      author
    );
    expect(message.threadId).toBe('slack:C0NATIVE0');
    expect(harness.decodeThreadId(message.threadId).threadTs).toBe('');
  });

  test("a thread's root read back from history belongs to the channel too", () => {
    const message = harness.buildMessage(
      {
        channel: 'C0NATIVE0',
        text: 'hi',
        thread_ts: '1.000100',
        ts: '1.000100',
      },
      author
    );
    expect(message.threadId).toBe('slack:C0NATIVE0');
  });

  test('a reply in a thread someone started keeps its own thread', () => {
    const message = harness.buildMessage(
      {
        channel: 'C0NATIVE0',
        text: 'hi',
        thread_ts: '1.000100',
        ts: '2.000200',
      },
      author
    );
    expect(message.threadId).toBe('slack:C0NATIVE0:1.000100');
  });

  test('anywhere else, a top-level message roots its own thread', () => {
    const message = harness.buildMessage(
      { channel: 'C0PLAIN0', text: 'hi', ts: '1.000100' },
      author
    );
    expect(message.threadId).toBe('slack:C0PLAIN0:1.000100');
  });
});
