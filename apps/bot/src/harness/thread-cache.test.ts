import { expect, test } from 'bun:test';
import { ThreadCache } from './thread-cache';

const KEY = 'C1:100.000001';

function seeded(): ThreadCache {
  const cache = new ThreadCache();
  cache.beginRead(KEY);
  cache.finishRead({
    key: KEY,
    oldest: undefined,
    raw: [
      { text: 'root', ts: '100.000001' },
      { text: 'first', thread_ts: '100.000001', ts: '100.000002' },
    ],
  });
  return cache;
}

const texts = (cache: ThreadCache, oldest?: string) =>
  cache.get({ key: KEY, oldest })?.map((entry) => entry.text);

test('a new reply, an edit and a deletion all reach the cached thread', () => {
  const cache = seeded();
  cache.apply({
    channel: 'C1',
    text: 'second',
    thread_ts: '100.000001',
    ts: '100.000003',
  });
  cache.apply({
    channel: 'C1',
    message: {
      text: 'first, edited',
      thread_ts: '100.000001',
      ts: '100.000002',
    },
    subtype: 'message_changed',
  });
  expect(texts(cache)).toEqual(['root', 'first, edited', 'second']);
  cache.apply({
    channel: 'C1',
    deleted_ts: '100.000002',
    previous_message: { thread_ts: '100.000001', ts: '100.000002' },
    subtype: 'message_deleted',
  });
  expect(texts(cache)).toEqual(['root', 'second']);
});

test('another thread, a repeat and an out-of-order reply change nothing wrong', () => {
  const cache = seeded();
  cache.apply({ channel: 'C2', thread_ts: '100.000001', ts: '100.000009' });
  cache.apply({
    channel: 'C1',
    text: 'dupe',
    thread_ts: '100.000001',
    ts: '100.000002',
  });
  cache.apply({
    channel: 'C1',
    text: 'late',
    thread_ts: '100.000001',
    ts: '100.0000015',
  });
  expect(texts(cache)).toEqual(['root', 'late', 'first']);
});

test('nothing is served before a first read lands, or for another starting point', () => {
  const cache = new ThreadCache();
  cache.beginRead(KEY);
  expect(cache.get({ key: KEY, oldest: undefined })).toBeUndefined();
  expect(texts(seeded(), '100.000002')).toBeUndefined();
});

test('an event during a re-read is replayed onto it, and drift is reported', () => {
  const cache = seeded();
  cache.beginRead(KEY);
  cache.apply({
    channel: 'C1',
    text: 'mid-read',
    thread_ts: '100.000001',
    ts: '100.000004',
  });
  // Slack served the read before the new reply, and kyto's own reply (whose
  // events never came) is in it.
  const { drifted } = cache.finishRead({
    key: KEY,
    oldest: undefined,
    raw: [
      { text: 'root', ts: '100.000001' },
      { text: 'first', thread_ts: '100.000001', ts: '100.000002' },
      { text: 'kyto reply', thread_ts: '100.000001', ts: '100.000003' },
    ],
  });
  expect(drifted).toBe(true);
  expect(texts(cache)).toEqual(['root', 'first', 'kyto reply', 'mid-read']);
});

test('a reconnect or a failed read leaves nothing to trust', () => {
  const cache = seeded();
  cache.clear();
  expect(texts(cache)).toBeUndefined();
  const again = seeded();
  again.dropRead(KEY);
  expect(texts(again)).toBeUndefined();
});
