import { describe, expect, it } from "vitest";
import { createLockServiceConformanceSuite } from "@tpirs/contracts";
import { createMockLockService } from "./index.js";

createLockServiceConformanceSuite({ describe, it, expect }, () => ({
  port: createMockLockService(),
}));

describe("createMockLockService", () => {
  it("tracks held keys", async () => {
    const locks = createMockLockService();
    const lock = await locks.acquire("k", 10);
    expect(locks.heldKeys()).toContain("k");
    if (lock !== undefined) {
      await locks.release(lock);
    }
    expect(locks.heldKeys()).toHaveLength(0);
  });
});
