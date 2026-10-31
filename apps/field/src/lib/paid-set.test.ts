import { describe, expect, it } from "vitest";
import { isRollover, isStale, normaliseReference, paidEntries, unpaidEntries } from "./paid-set.js";
import type { PaidSetDelta, PaidSetEntry } from "./paid-set.js";

function entry(overrides: Partial<PaidSetEntry> = {}): PaidSetEntry {
  return {
    assetId: "asset-1",
    qrPayload: "payload-1",
    shortCode: "A000001",
    assetTypeKey: "bike",
    attributes: { plate_number: "MTZ56AA" },
    paid: true,
    changedAt: "2026-06-15T09:00:00.000Z",
    ...overrides,
  };
}

function delta(overrides: Partial<PaidSetDelta> = {}): PaidSetDelta {
  return {
    mode: "snapshot",
    businessDate: "2026-06-15",
    entries: [],
    nextCursor: null,
    hasMore: false,
    serverTime: "2026-06-15T09:00:00.000Z",
    ...overrides,
  };
}

describe("isRollover", () => {
  it("is false on the first sync, when there is no cached date", () => {
    expect(isRollover(undefined, "2026-06-15")).toBe(false);
  });

  it("is true when the cached set belongs to an earlier day", () => {
    expect(isRollover("2026-06-14", "2026-06-15")).toBe(true);
  });

  it("is false within the same business day", () => {
    expect(isRollover("2026-06-15", "2026-06-15")).toBe(false);
  });
});

describe("entry partitioning", () => {
  it("separates entries to store from entries to remove", () => {
    const page = delta({
      entries: [entry(), entry({ qrPayload: "payload-2", paid: false })],
    });
    expect(paidEntries(page).map((item) => item.qrPayload)).toEqual(["payload-1"]);
    expect(unpaidEntries(page).map((item) => item.qrPayload)).toEqual(["payload-2"]);
  });

  it("treats presence in the feed as payment only when the row says paid", () => {
    // A reversal arrives as paid:false; storing it would let a cache confirm a
    // payment that no longer exists.
    const page = delta({ entries: [entry({ paid: false })] });
    expect(paidEntries(page)).toHaveLength(0);
  });
});

describe("isStale", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("is stale when the phone has never synced", () => {
    expect(isStale(undefined, 8, now)).toBe(true);
  });

  it("is fresh inside the tenant's grace window", () => {
    expect(isStale("2026-06-15T09:00:00Z", 8, now)).toBe(false);
  });

  it("is stale past the grace window", () => {
    expect(isStale("2026-06-15T03:00:00Z", 8, now)).toBe(true);
  });

  it("is stale when the stored time cannot be read", () => {
    expect(isStale("not-a-date", 8, now)).toBe(true);
  });
});

describe("normaliseReference", () => {
  it("treats the ways an officer types a short code as one reference", () => {
    expect(normaliseReference(" b 000123 ")).toBe("B000123");
    expect(normaliseReference("B-000123")).toBe("B000123");
    expect(normaliseReference("b000123")).toBe("B000123");
  });

  it("keeps an empty entry empty", () => {
    expect(normaliseReference("   ")).toBe("");
  });
});
