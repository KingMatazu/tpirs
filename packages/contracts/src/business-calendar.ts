import { businessDate } from "@tpirs/domain";
import type { BusinessCalendar } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createBusinessCalendarConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<BusinessCalendar>,
): void {
  const { describe, it, expect } = harness;

  describe("BusinessCalendar conformance", () => {
    it("computes a YYYY-MM-DD business day for an instant", () =>
      withAdapter(factory, (calendar) => {
        const day = calendar.businessDay(new Date("2026-10-20T12:00:00Z"), "Africa/Lagos");
        expect(day).toBe("2026-10-20");
      }));

    it("answers isBusinessDay with a boolean", () =>
      withAdapter(factory, (calendar) => {
        expect(typeof calendar.isBusinessDay(businessDate("2026-10-20"), "Africa/Lagos")).toBe(
          "boolean",
        );
      }));
  });
}
