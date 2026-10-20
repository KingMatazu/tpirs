export interface Lock {
  readonly key: string;
  readonly token: string;
}

export interface LockService {
  /** Returns undefined when the lock is already held (non-blocking). */
  acquire(key: string, ttlSeconds: number): Promise<Lock | undefined>;
  /** Returns false when the token does not own the lock. */
  release(lock: Lock): Promise<boolean>;
}

/** Run fn while holding the lock; releases even when fn throws. */
export async function withLock<T>(
  locks: LockService,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await locks.acquire(key, ttlSeconds);
  if (lock === undefined) {
    throw new Error(`Lock "${key}" is already held`);
  }
  try {
    return await fn();
  } finally {
    await locks.release(lock);
  }
}
