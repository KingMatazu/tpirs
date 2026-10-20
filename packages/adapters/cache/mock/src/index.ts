import type { Cache } from "@tpirs/ports";

export interface MockCacheOptions {
  /** Seconds-to-milliseconds clock; inject to test TTL expiry. */
  readonly now?: () => number;
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number | undefined;
}

export interface MockCache extends Cache {
  clear(): void;
}

export function createMockCache(options: MockCacheOptions = {}): MockCache {
  const now = options.now ?? Date.now;
  const store = new Map<string, Entry>();

  function live(key: string): Entry | undefined {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    get(key) {
      return Promise.resolve(live(key)?.value);
    },
    set(key, value, ttlSeconds) {
      const expiresAt = ttlSeconds === undefined ? undefined : now() + ttlSeconds * 1000;
      store.set(key, { value, expiresAt });
      return Promise.resolve();
    },
    delete(key) {
      store.delete(key);
      return Promise.resolve();
    },
    clear() {
      store.clear();
    },
  };
}
