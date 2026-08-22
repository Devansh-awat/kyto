import { describe, expect, test } from 'bun:test';
import { resolvePollTarget } from './poll-target';

// The whole fix lives in this decision: "post it in the channel" must drop the
// thread_ts for the owner, and for everyone else fall back INTO the thread —
// visibly — rather than pretending it reached the channel. A wrong branch here
// either leaks top-level posts to non-owners or silently misplaces a poll.
describe('resolvePollTarget', () => {
  const ts = '1787328082.741149';

  test('owner asking for the channel gets a top-level post', () => {
    expect(resolvePollTarget('channel', true, ts)).toEqual({
      redirectedToThread: false,
      threadTs: undefined,
    });
  });

  test('anyone else asking for the channel is placed back in the thread', () => {
    expect(resolvePollTarget('channel', false, ts)).toEqual({
      redirectedToThread: true,
      threadTs: ts,
    });
  });

  test('at channel level there is nothing to redirect into', () => {
    expect(resolvePollTarget('channel', false, undefined)).toEqual({
      redirectedToThread: false,
      threadTs: undefined,
    });
    expect(resolvePollTarget('channel', true, undefined)).toEqual({
      redirectedToThread: false,
      threadTs: undefined,
    });
  });

  test('the default keeps posting inside the current thread', () => {
    expect(resolvePollTarget('thread', true, ts)).toEqual({
      redirectedToThread: false,
      threadTs: ts,
    });
    expect(resolvePollTarget('thread', false, ts)).toEqual({
      redirectedToThread: false,
      threadTs: ts,
    });
    expect(resolvePollTarget('thread', false, undefined)).toEqual({
      redirectedToThread: false,
      threadTs: undefined,
    });
  });
});
