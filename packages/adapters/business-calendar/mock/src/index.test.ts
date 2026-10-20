import { describe, expect, it } from "vitest";
import { createBusinessCalendarConformanceSuite } from "@tpirs/contracts";
import { createMockBusinessCalendar } from "./index.js";

createBusinessCalendarConformanceSuite({ describe, it, expect }, () => ({
  port: createMockBusinessCalendar(),
}));

describe("createMockBusinessCalendar", () => {
  const calendar = createMockBusinessCalendar({ holidays: ["2026-10-20"] });

  it("treats weekends as non-business days", () => {
    expect(calendar.isBusinessDay("2026-10-17", "Africa/Lagos")).toBe(false); // Saturday
    expect(calendar.isBusinessDay("2026-10-18", "Africa/Lagos")).toBe(false); // Sunday
    expect(calendar.isBusinessDay("2026-10-19", "Africa/Lagos")).toBe(true); // Monday
  });

  it("treats configured holidays as non-business days", () => {
    expect(calendar.isBusinessDay("2026-10-20", "Africa/Lagos")).toBe(false);
  });
});
