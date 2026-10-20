import type { Lock, LockService } from "@tpirs/ports";
import { withLock } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createLockServiceConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<LockService>,
): void {
  const { describe, it, expect } = harness;

  async function requireHeld(locks: LockService, key: string): Promise<Lock> {
    const lock = await locks.acquire(key, 30);
    if (lock === undefined) {
      throw new Error(`expected lock "${key}" to be acquired`);
    }
    return lock;
  }

  describe("LockService conformance", () => {
    it("acquires and releases a free lock", () =>
      withAdapter(factory, async (locks) => {
        const lock = await requireHeld(locks, "conf-lock-1");
        expect(await locks.release(lock)).toBe(true);
      }));

    it("does not hand out a held lock", () =>
      withAdapter(factory, async (locks) => {
        const lock = await requireHeld(locks, "conf-lock-2");
        expect(await locks.acquire("conf-lock-2", 30)).toBeUndefined();
        await locks.release(lock);
      }));

    it("releasing with a stale token fails", () =>
      withAdapter(factory, async (locks) => {
        const lock = await requireHeld(locks, "conf-lock-3");
        await locks.release(lock);
        expect(await locks.release(lock)).toBe(false);
      }));

    it("withLock runs the body and frees the lock", () =>
      withAdapter(factory, async (locks) => {
        await withLock(locks, "conf-lock-4", 30, async () => {
          // no-op body for conformance
        });
        const lock = await requireHeld(locks, "conf-lock-4");
        await locks.release(lock);
      }));
  });
}
