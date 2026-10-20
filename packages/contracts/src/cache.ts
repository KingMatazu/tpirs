import type { Cache } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createCacheConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<Cache>,
): void {
  const { describe, it, expect } = harness;

  describe("Cache conformance", () => {
    it("round-trips a value", () =>
      withAdapter(factory, async (cache) => {
        await cache.set("conf:key", { n: 42 });
        expect(await cache.get("conf:key")).toEqual({ n: 42 });
      }));

    it("returns undefined for missing keys", () =>
      withAdapter(factory, async (cache) => {
        expect(await cache.get("conf:missing")).toBeUndefined();
      }));

    it("deletes keys", () =>
      withAdapter(factory, async (cache) => {
        await cache.set("conf:deleteme", "value");
        await cache.delete("conf:deleteme");
        expect(await cache.get("conf:deleteme")).toBeUndefined();
      }));
  });
}
