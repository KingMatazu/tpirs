import type { Clock } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createClockConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<Clock>,
): void {
  const { describe, it, expect } = harness;

  describe("Clock conformance", () => {
    it("returns a Date close to the wall clock", () =>
      withAdapter(factory, (clock) => {
        const before = Date.now();
        const now = clock.now();
        const after = Date.now();
        expect(now).toBeInstanceOf(Date);
        expect(now.getTime()).toBeGreaterThanOrEqual(before);
        expect(now.getTime()).toBeLessThanOrEqual(after);
      }));
  });
}
