import { describe, expect, it } from "vitest";
import {
  assetLabel,
  depositStatusLabel,
  heldHours,
  isOverdue,
  matchCandidates,
  newClientReference,
  prefillAmountMinor,
  walletStatusLabel,
  type CashDepositView,
  type CashIntakeView,
  type CashWalletView,
} from "./collectorsView.js";
import { loadFixtureConfig } from "../test-support/tenant.js";

/**
 * The pure rules behind the collector screen. The fee pre-fill is the one that
 * can quietly take the wrong amount, so it is pinned here: the newest rule that
 * is already effective wins, a future rule is ignored, and an unknown asset
 * type pre-fills nothing (the API then rejects the intake rather than guessing).
 */

const config = loadFixtureConfig();

const baseWallet: CashWalletView = {
  collectorUserId: "c1",
  status: "active",
  frozenAt: null,
  frozenReason: null,
  overdueSince: null,
  floatCeilingMinor: null,
  balanceMinor: "0",
  openIntakeTotalMinor: "0",
  oldestOpenIntakeAt: null,
  lastDepositAt: null,
};

describe("prefillAmountMinor", () => {
  it("uses the newest rule that is already effective", () => {
    const withRule = {
      ...config,
      obligations: {
        ...config.obligations,
        feeRules: [
          { key: "old", assetTypeKey: "bike", amountMinor: 10000, effectiveFrom: "2026-01-01" },
          { key: "new", assetTypeKey: "bike", amountMinor: 20000, effectiveFrom: "2026-06-01" },
          { key: "future", assetTypeKey: "bike", amountMinor: 30000, effectiveFrom: "2027-01-01" },
        ],
      },
    };
    expect(prefillAmountMinor(withRule, "bike", "2026-10-28")).toBe("20000");
    expect(prefillAmountMinor(withRule, "bike", "2026-03-01")).toBe("10000");
  });

  it("returns undefined for an asset type the tenant has no rule for", () => {
    expect(prefillAmountMinor(config, "market-stall", "2026-10-28")).toBeUndefined();
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("trusts the server's overdue flag", () => {
    expect(isOverdue({ ...baseWallet, overdueSince: "2026-10-28T09:00:00.000Z" }, 24, now)).toBe(
      true,
    );
  });

  it("derives the same answer from the oldest open intake", () => {
    expect(
      isOverdue({ ...baseWallet, oldestOpenIntakeAt: "2026-10-27T11:00:00.000Z" }, 24, now),
    ).toBe(true);
    expect(
      isOverdue({ ...baseWallet, oldestOpenIntakeAt: "2026-10-28T01:00:00.000Z" }, 24, now),
    ).toBe(false);
  });

  it("is never overdue with nothing held", () => {
    expect(isOverdue(baseWallet, 0, now)).toBe(false);
  });
});

describe("heldHours", () => {
  it("floors to whole hours and never goes negative", () => {
    const now = new Date("2026-10-28T12:30:00.000Z");
    expect(heldHours("2026-10-28T10:00:00.000Z", now)).toBe(2);
    expect(heldHours("2026-10-28T13:00:00.000Z", now)).toBe(0);
  });
});

describe("matchCandidates", () => {
  it("offers suspense deposits against open intakes only", () => {
    const deposits: CashDepositView[] = [
      {
        id: "d1",
        provider: "mock",
        providerReference: "MOCK-1",
        collectorUserId: "c1",
        amountMinor: "20000",
        currency: "NGN",
        status: "suspense",
        createdAt: "2026-10-27T18:00:00.000Z",
      },
      {
        id: "d2",
        provider: "mock",
        providerReference: "MOCK-2",
        collectorUserId: "c1",
        amountMinor: "20000",
        currency: "NGN",
        status: "matched",
        createdAt: "2026-10-27T19:00:00.000Z",
      },
    ];
    const intakes: CashIntakeView[] = [
      {
        id: "i1",
        collectorUserId: "c1",
        assetId: "as_1",
        zoneId: null,
        businessDate: "2026-10-27",
        amountMinor: "20000",
        currency: "NGN",
        status: "open",
        receiptNumber: "RCPT-1",
        recordedAt: "2026-10-27T09:00:00.000Z",
      },
      {
        id: "i2",
        collectorUserId: "c1",
        assetId: "as_2",
        zoneId: null,
        businessDate: "2026-10-26",
        amountMinor: "20000",
        currency: "NGN",
        status: "matched",
        receiptNumber: "RCPT-0",
        recordedAt: "2026-10-26T09:00:00.000Z",
      },
    ];

    const candidates = matchCandidates(deposits, intakes);
    expect(candidates.suspense.map((row) => row.id)).toEqual(["d1"]);
    expect(candidates.open.map((row) => row.id)).toEqual(["i1"]);
  });
});

describe("labels and references", () => {
  it("explains wallet and deposit states without changing the enum", () => {
    expect(walletStatusLabel(baseWallet)).toBe("Active");
    expect(walletStatusLabel({ ...baseWallet, overdueSince: "2026-10-28T09:00:00.000Z" })).toBe(
      "Active (overdue)",
    );
    expect(walletStatusLabel({ ...baseWallet, status: "frozen" })).toBe("Frozen");
    expect(depositStatusLabel("matched")).toBe("Matched");
    expect(depositStatusLabel("partial")).toBe("Partly matched");
    expect(depositStatusLabel("suspense")).toBe("In suspense");
  });

  it("mints a distinct browser reference per intake", () => {
    const first = newClientReference("c1");
    const second = newClientReference("c1");
    expect(first).toMatch(/^cash-c1-/);
    expect(first).not.toBe(second);
  });

  it("prefers the plate number for the driver-facing label", () => {
    expect(
      assetLabel({
        id: "as_1",
        assetTypeKey: "bike",
        shortCode: "B123",
        attributes: { plate_number: "AB-123" },
      }),
    ).toBe("AB-123");
    expect(
      assetLabel({ id: "as_1", assetTypeKey: "bike", shortCode: "B123", attributes: {} }),
    ).toBe("B123");
  });
});
