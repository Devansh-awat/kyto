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
// In memory on purpose: a restart costs one extra loadTools call in whichever
// threads were live, which is not worth a table. loadTools' summary says so —
// it once promised "the rest of this thread" and the model then called a
// dropped tool without loading it (issue #23).

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
  const entry = store.get(threadId);
  if (entry) {
    for (const name of incoming) {
      entry.names.add(name);
    }
    entry.at = Date.now();
    // Re-insert so the map stays in least-recently-used order for the cap.
    store.delete(threadId);
    store.set(threadId, entry);
  } else {
    store.set(threadId, {
      at: Date.now(),
      names: new Set(incoming),
      order: { names: [] },
    });
  }
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
  const order = { names: [] };
  store.set(threadId, { at: Date.now(), names: new Set(), order });
  sweep();
  return order;
}
