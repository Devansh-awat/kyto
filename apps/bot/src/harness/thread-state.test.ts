import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface Row {
  focusUserIds: string[] | null;
  respondAs: 'app' | 'user';
  respondOnThreadMessages: boolean;
}

const rows = new Map<string, Row>();
const calls = { reads: 0, writes: 0 };
// When set, a read snapshots the row at once and answers only once released:
// a query that was in flight while something else wrote.
let readGate: Promise<void> | undefined;

// bun shares one module registry across test files, so this mock outlives
// the file: keep every real export and override only what is under test.
const real = await import('@repo/db/queries');

mock.module('@repo/db/queries', () => ({
  ...real,
  deleteThreadSubscription: (threadId: string) => {
    rows.delete(threadId);
    return Promise.resolve();
  },
  getThreadSubscription: async (threadId: string) => {
    calls.reads++;
    const seen = rows.get(threadId) ?? null;
    if (readGate) {
      await readGate;
    }
    return seen;
  },
  setThreadFocus: () => Promise.resolve(),
  setThreadSubscription: ({
    respondAs,
    respondOnThreadMessages,
    threadId,
  }: {
    respondAs?: 'app' | 'user';
    respondOnThreadMessages: boolean;
    threadId: string;
  }) => {
    calls.writes++;
    const stored = rows.get(threadId);
    rows.set(threadId, {
      focusUserIds: stored?.focusUserIds ?? null,
      respondAs: respondAs ?? stored?.respondAs ?? 'app',
      respondOnThreadMessages,
    });
    return Promise.resolve();
  },
}));

const { ThreadHandle } = await import('./thread');

let next = 0;
function handle() {
  next++;
  return new ThreadHandle({
    harness: {} as never,
    id: `slack:C1:${next}.0`,
    logger: { warn: () => undefined } as never,
  });
}

beforeEach(() => {
  calls.reads = 0;
  calls.writes = 0;
});

describe('setState', () => {
  test('writes a thread it has no row for', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    expect(calls.writes).toBe(1);
    expect(rows.get(thread.id)?.respondOnThreadMessages).toBe(true);
  });

  test('skips the upsert when the row already says the same', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    expect(calls.writes).toBe(1);
  });

  test('a ping of the other kyto still takes the thread over', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    await thread.setState({ respondAs: 'user', respondOnThreadMessages: true });
    expect(calls.writes).toBe(2);
    expect((await thread.state)?.respondAs).toBe('user');
  });

  test('leaving a followed thread still writes', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    await thread.setState({ respondOnThreadMessages: false });
    expect(calls.writes).toBe(2);
    expect((await thread.state)?.respondOnThreadMessages).toBe(false);
  });

  test('an omitted respondAs keeps whichever kyto follows it', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'user', respondOnThreadMessages: true });
    await thread.setState({ respondOnThreadMessages: true });
    expect(calls.writes).toBe(1);
    expect((await thread.state)?.respondAs).toBe('user');
  });

  test('subscribe on an already-followed DM writes nothing', async () => {
    const thread = handle();
    await thread.subscribe();
    const first = calls.writes;
    await thread.subscribe();
    await thread.subscribe();
    expect(first).toBe(1);
    expect(calls.writes).toBe(1);
  });

  test('a skip never hides a row changed behind the cache past its TTL', async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    // The other process's write, which this cache has not seen.
    rows.set(thread.id, {
      focusUserIds: null,
      respondAs: 'user',
      respondOnThreadMessages: true,
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      await thread.setState({
        respondAs: 'app',
        respondOnThreadMessages: true,
      });
    } finally {
      Date.now = realNow;
    }
    expect(calls.writes).toBe(2);
    expect(rows.get(thread.id)?.respondAs).toBe('app');
  });
});

describe('a read racing a write', () => {
  test("a read in flight during the other kyto's takeover doesn't cache the old row", async () => {
    const thread = handle();
    await thread.setState({ respondAs: 'app', respondOnThreadMessages: true });
    const realNow = Date.now;
    // Past the TTL, so the next read goes to the row.
    Date.now = () => realNow() + 60_000;
    try {
      let release: () => void = () => undefined;
      readGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The app's read sees the row as 'app'...
      const appRead = thread.state;
      readGate = undefined;
      // ...then the account takes the thread over before that read answers.
      const account = new ThreadHandle({
        harness: {} as never,
        id: thread.id,
        logger: { warn: () => undefined } as never,
      });
      await account.setState({
        respondAs: 'user',
        respondOnThreadMessages: true,
      });
      release();
      expect((await appRead)?.respondAs).toBe('app');
      // Had the stale read been cached, this would say 'app' for 30 s, and a
      // ping of the app would skip its write and leave the account following.
      expect((await thread.state)?.respondAs).toBe('user');
      const writes = calls.writes;
      await thread.setState({
        respondAs: 'app',
        respondOnThreadMessages: true,
      });
      expect(calls.writes).toBe(writes + 1);
      expect(rows.get(thread.id)?.respondAs).toBe('app');
    } finally {
      Date.now = realNow;
      readGate = undefined;
    }
  });
});
