import { describe, expect, it } from "vitest";
import { createCacheConformanceSuite } from "@tpirs/contracts";
import { createMockCache } from "./index.js";

createCacheConformanceSuite({ describe, it, expect }, () => ({ port: createMockCache() }));

describe("createMockCache TTL", () => {
  it("expires values after the TTL", async () => {
    let clock = 0;
    const cache = createMockCache({ now: () => clock });
    await cache.set("ttl", "value", 10);
    expect(await cache.get("ttl")).toBe("value");
    clock = 9_999;
    expect(await cache.get("ttl")).toBe("value");
    clock = 10_000;
    expect(await cache.get("ttl")).toBeUndefined();
  });
});
