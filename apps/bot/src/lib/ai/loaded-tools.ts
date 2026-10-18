// Which deferred tools a thread has already loaded.
//
// `loadTools` used to be scoped to a single turn: the model loaded `gh`, used
// it, and on the very next message in the SAME thread the tool was gone again —
// kyto's own reasoning read "the gh tool was loaded in a previous turn but isn't
// available now, let me reload it". Every turn of a long GitHub thread paid an
// extra full-price round trip to re-learn something it already knew.
//
// It also churned the prompt cache. Tool schemas are serialized ahead of the
// messages, so a tools array that GROWS mid-turn invalidates the cached prefix
// from byte zero for the rest of that turn. Remembering the set means the
// second and later turns of a thread start with those tools already active and
// never mutate the array mid-turn.
//
// Served from memory, saved to `thread_loaded_tools` on every change and read
// back the first time a thread is seen after a restart. It used to be memory
// only, on the theory that a restart costs one extra loadTools call — but it
// also changed the tools array, the very front of the cached prompt, so the
// first turn of every live thread after a deploy read 0 from cache (measured
// 2026-10-17: 23 of 39 haiku turns' first request). Every push is a restart.

import {
  deleteStaleThreadLoadedTools,
  getThreadLoadedTools,
  saveThreadLoadedTools,
} from '@repo/db/queries';
import logger from '@/lib/logger';

// Long enough to cover a working session, short enough that a thread nobody
// touches again stops holding schemas.
const TTL_MS = 6 * 60 * 60 * 1000;
// Bound the map so a busy workspace can't grow it without limit. Oldest first.
const MAX_THREADS = 500;

interface Entry {
  at: number;
  names: Set<string>;
  // The order the thread's tools were last serialized in (stabilizeToolOrder's
  // state), so the next turn sends them in the same order — a reshuffle
  // invalidates every cached byte after the tools.
  order: { names: string[] };
}

const store = new Map<string, Entry>();
const PURGE_EVERY_MS = 60 * 60 * 1000;
let purgedAt = 0;

function save(threadId: string, entry: Entry): void {
  saveThreadLoadedTools({
    names: [...entry.names],
    threadId,
    toolOrder: entry.order.names,
  }).catch((error: unknown) => {
    logger.warn({ error, threadId }, '[loaded-tools] save failed');
  });
}

// The order is reassigned by stabilizeToolOrder on every request, by whichever
// caller holds it (turns, subagents, reminders, Kevinton), so the save hangs
// off the assignment instead of each of them remembering to make one.
function createEntry({
  names,
  order,
  threadId,
}: {
  names: Iterable<string>;
  order: string[];
  threadId: string;
}): Entry {
  let current = order;
  const entry: Entry = {
    at: Date.now(),
    names: new Set(names),
    order: {
      get names() {
        return current;
      },
      set names(next: string[]) {
        const same =
          next.length === current.length &&
          next.every((name, index) => name === current[index]);
        current = next;
        if (!same) {
          save(threadId, entry);
        }
      },
    },
  };
  return entry;
}

/**
 * Load the thread's saved tools into memory if this process hasn't seen it in
 * the TTL. Before recallLoadedTools/threadToolOrder; a failed read is a cold
 * thread, as before the table.
 */
export async function hydrateLoadedTools(threadId: string): Promise<void> {
  const known = store.get(threadId);
  if (known && known.at >= Date.now() - TTL_MS) {
    return;
  }
  const since = new Date(Date.now() - TTL_MS);
  if (Date.now() - purgedAt > PURGE_EVERY_MS) {
    purgedAt = Date.now();
    deleteStaleThreadLoadedTools(since).catch((error: unknown) => {
      logger.warn({ error }, '[loaded-tools] purge failed');
    });
  }
  const row = await getThreadLoadedTools({ since, threadId }).catch(
    (error: unknown) => {
      logger.warn({ error, threadId }, '[loaded-tools] read failed');
      return;
    }
  );
  // A concurrent turn in the same thread may have filled it while we read.
  if (!row || store.has(threadId)) {
    return;
  }
  store.set(
    threadId,
    createEntry({ names: row.names, order: row.toolOrder, threadId })
  );
  sweep();
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [threadId, entry] of store) {
    if (entry.at < cutoff) {
      store.delete(threadId);
    }
  }
  while (store.size > MAX_THREADS) {
    const oldest = store.keys().next();
    if (oldest.done) {
      return;
    }
    store.delete(oldest.value);
  }
}

export function recallLoadedTools(threadId: string): string[] {
  const entry = store.get(threadId);
  if (!entry) {
    return [];
  }
  if (entry.at < Date.now() - TTL_MS) {
    store.delete(threadId);
    return [];
  }
  // A recall is a use: a thread still being worked in keeps its tools past
  // the TTL, which used to run from the last loadTools call alone.
  entry.at = Date.now();
  return [...entry.names];
}

export function rememberLoadedTools(
  threadId: string,
  names: Iterable<string>
): void {
  const incoming = [...names];
  if (incoming.length === 0) {
    return;
  }
  let entry = store.get(threadId);
  if (entry) {
    for (const name of incoming) {
      entry.names.add(name);
    }
    entry.at = Date.now();
    // Re-insert so the map stays in least-recently-used order for the cap.
    store.delete(threadId);
    store.set(threadId, entry);
  } else {
    entry = createEntry({ names: incoming, order: [], threadId });
    store.set(threadId, entry);
  }
  save(threadId, entry);
  sweep();
}

/**
 * The thread's tool-order state, created on first use. The SAME object every
 * turn, mutated by the request it is passed to.
 */
export function threadToolOrder(threadId: string): { names: string[] } {
  const entry = store.get(threadId);
  if (entry && entry.at >= Date.now() - TTL_MS) {
    entry.at = Date.now();
    return entry.order;
  }
  const created = createEntry({ names: [], order: [], threadId });
  store.set(threadId, created);
  sweep();
  return created.order;
}
