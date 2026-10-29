import { describe, expect, it } from "vitest";
import {
  addDays,
  businessDate,
  businessDayRange,
  compareBusinessDates,
  todayInTimeZone,
} from "./business-date.js";
import { InvalidBusinessDateError } from "./errors.js";

describe("businessDate", () => {
  it("accepts real calendar dates", () => {
    expect(businessDate("2026-10-20")).toBe("2026-10-20");
    expect(businessDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => businessDate("2026-10-2")).toThrow(InvalidBusinessDateError);
    expect(() => businessDate("2026-13-01")).toThrow(InvalidBusinessDateError);
    expect(() => businessDate("2025-02-29")).toThrow(InvalidBusinessDateError);
  });
});

describe("todayInTimeZone", () => {
  it("computes the business day in the tenant timezone, not UTC", () => {
    const lateUtc = new Date("2026-10-20T23:30:00Z");
    expect(todayInTimeZone("UTC", lateUtc)).toBe("2026-10-20");
    expect(todayInTimeZone("Africa/Lagos", lateUtc)).toBe("2026-10-21");
    const earlyUtc = new Date("2026-10-20T00:30:00Z");
    expect(todayInTimeZone("Africa/Lagos", earlyUtc)).toBe("2026-10-20");
    expect(todayInTimeZone("Pacific/Auckland", earlyUtc)).toBe("2026-10-20");
    expect(todayInTimeZone("America/Los_Angeles", earlyUtc)).toBe("2026-10-19");
  });
});

describe("addDays and compareBusinessDates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays(businessDate("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(businessDate("2026-01-01"), -1)).toBe("2025-12-31");
  });

  it("compares lexicographically (safe for zero-padded YYYY-MM-DD)", () => {
    expect(compareBusinessDates(businessDate("2026-01-01"), businessDate("2026-01-02"))).toBe(-1);
    expect(compareBusinessDates(businessDate("2026-01-02"), businessDate("2026-01-02"))).toBe(0);
    expect(compareBusinessDates(businessDate("2026-01-03"), businessDate("2026-01-02"))).toBe(1);
  });
});

describe("businessDayRange", () => {
  it("covers the whole day in UTC", () => {
    const range = businessDayRange("UTC", businessDate("2026-10-20"));
    expect(range.start.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });

  it("covers the whole day in a half-hour zone", () => {
    const range = businessDayRange("Asia/Kolkata", businessDate("2026-10-20"));
    expect(range.start.toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-10-20T18:30:00.000Z");
  });

  it("crosses a DST start with the right instant", () => {
    // 2026-03-08 is the US spring-forward day: local midnight exists, at 05Z.
    const range = businessDayRange("America/New_York", businessDate("2026-03-08"));
    expect(range.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    const next = range.endExclusive;
    expect(next.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(todayInTimeZone("America/New_York", range.start)).toBe("2026-03-08");
    expect(todayInTimeZone("America/New_York", range.endExclusive)).toBe("2026-03-09");
  });

  it("round-trips through todayInTimeZone for extreme offsets", () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Africa/Lagos"]) {
      const range = businessDayRange(zone, businessDate("2026-10-20"));
      expect(todayInTimeZone(zone, range.start)).toBe("2026-10-20");
      expect(todayInTimeZone(zone, range.endExclusive)).toBe("2026-10-21");
    }
  });
});
