import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./next-occurrence.js";

/**
 * The one place cron-parser is used (D48/ADR 0040). These tests pin the
 * semantics the scheduler relies on: the occurrence is strictly after the
 * given instant and is computed in the tenant's timezone.
 */
describe("nextOccurrence", () => {
  it("returns the next scheduled instant in the given timezone", () => {
    const next = nextOccurrence("0 2 * * *", new Date("2026-06-15T00:00:00Z"), "Etc/UTC");
    expect(next?.toISOString()).toBe("2026-06-15T02:00:00.000Z");
  });

  it("interprets the schedule in the tenant's zone, not the server's", () => {
    // 02:00 in Lagos (UTC+1) is 01:00Z.
    const next = nextOccurrence("0 2 * * *", new Date("2026-06-15T00:00:00Z"), "Africa/Lagos");
    expect(next?.toISOString()).toBe("2026-06-15T01:00:00.000Z");
  });

  it("is strictly after the given instant", () => {
    const next = nextOccurrence("0 2 * * *", new Date("2026-06-15T02:00:00Z"), "Etc/UTC");
    expect(next?.toISOString()).toBe("2026-06-16T02:00:00.000Z");
  });

  it("returns undefined for an expression the parser rejects", () => {
    expect(
      nextOccurrence("every day", new Date("2026-06-15T00:00:00Z"), "Etc/UTC"),
    ).toBeUndefined();
  });
});
