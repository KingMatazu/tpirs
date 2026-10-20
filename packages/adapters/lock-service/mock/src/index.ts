import type { Lock, LockService } from "@tpirs/ports";

export interface MockLockService extends LockService {
  /** Keys currently held (test inspection). */
  heldKeys(): readonly string[];
}

export function createMockLockService(): MockLockService {
  const held = new Map<string, string>();
  let counter = 0;

  return {
    acquire(key, _ttlSeconds) {
      if (held.has(key)) return Promise.resolve(undefined);
      counter += 1;
      const token = `mock-lock-token-${String(counter)}`;
      held.set(key, token);
      return Promise.resolve({ key, token });
    },
    release(lock: Lock) {
      const token = held.get(lock.key);
      if (token === undefined || token !== lock.token) return Promise.resolve(false);
      held.delete(lock.key);
      return Promise.resolve(true);
    },
    heldKeys() {
      return [...held.keys()];
    },
  };
}
