// In-memory TTL key-value store replacing the chat-sdk's Postgres-backed
// state. Everything stored here is a rebuildable cache (opt-in allowlist,
// user/channel name lookups), so process-lifetime persistence is enough — the
// allowlist is rebuilt from channel membership at startup and the caches
// refill on demand.

interface Entry {
  expiresAt: number | null;
  value: unknown;
}

const SWEEP_AT = 5000;

export class MemoryKV {
  private readonly entries = new Map<string, Entry>();

  get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    // Expired entries were dropped only when read again, and most name lookups
    // never are. Only EXPIRED ones go: an entry without a TTL (the allowlist)
    // is state, not cache.
    if (this.entries.size >= SWEEP_AT) {
      const now = Date.now();
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          this.entries.delete(entryKey);
        }
      }
    }
    this.entries.set(key, {
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
      value,
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}
