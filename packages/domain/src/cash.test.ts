import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  COLLECTOR_CASH_ACCOUNT,
  CashError,
  assertWithinCeiling,
  canIntake,
  cashFundingPostings,
  classifyDeposit,
  depositAgeHours,
  isDepositOverdue,
  mirrorPostings,
  transitionWallet,
  validateBalancedTransaction,
} from "./index.js";
import { money } from "./money.js";

describe("transitionWallet", () => {
  it("freezes an active wallet and records the reason", () => {
    expect(
      transitionWallet({ status: "active", frozenReason: null }, "freeze", "shortfall"),
    ).toEqual({
      status: "frozen",
      frozenReason: "shortfall",
    });
  });

  it("freezing an already-frozen wallet is a no-op", () => {
    const frozen = { status: "frozen" as const, frozenReason: "first reason" };
    expect(transitionWallet(frozen, "freeze", "second reason")).toBe(frozen);
  });

  it("unfreezes a frozen wallet and clears the reason", () => {
    expect(
      transitionWallet({ status: "frozen", frozenReason: "shortfall" }, "unfreeze", null),
    ).toEqual({ status: "active", frozenReason: null });
  });

  it("unfreezing an active wallet is a no-op", () => {
    const active = { status: "active" as const, frozenReason: null };
    expect(transitionWallet(active, "unfreeze", null)).toBe(active);
  });

  it("keeps intake gated on the status", () => {
    expect(canIntake("active")).toBe(true);
    expect(canIntake("frozen")).toBe(false);
  });
});

describe("assertWithinCeiling", () => {
  const base = { balanceMinor: 100, intakeMinor: 50, ceilingMinor: 200 };

  it("allows an intake that stays within the ceiling", () => {
    expect(() => assertWithinCeiling(base)).not.toThrow();
  });

  it("is inclusive at the boundary", () => {
    expect(() => assertWithinCeiling({ ...base, intakeMinor: 100 })).not.toThrow();
  });

  it("rejects one unit past the ceiling", () => {
    try {
      assertWithinCeiling({ ...base, intakeMinor: 101 });
      expect.unreachable("must reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CashError);
      if (error instanceof CashError) expect(error.code).toBe("ceiling_exceeded");
    }
  });

  it("rejects non-positive intake amounts", () => {
    expect(() => assertWithinCeiling({ ...base, intakeMinor: 0 })).toThrow(CashError);
    expect(() => assertWithinCeiling({ ...base, intakeMinor: -5 })).toThrow(CashError);
  });

  it("rejects amounts that would overflow the float arithmetic", () => {
    expect(() =>
      assertWithinCeiling({
        balanceMinor: Number.MAX_SAFE_INTEGER - 1,
        intakeMinor: 2,
        ceilingMinor: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(CashError);
  });

  it("passes or throws exactly per the ceiling predicate", () => {
    const amount = fc.integer({ min: -10, max: 500 });
    const balance = fc.integer({ min: -10, max: 500 });
    const ceiling = fc.integer({ min: 1, max: 500 });
    fc.assert(
      fc.property(balance, amount, ceiling, (b, a, c) => {
        try {
          assertWithinCeiling({ balanceMinor: b, intakeMinor: a, ceilingMinor: c });
          return b >= 0 && a > 0 && b + a <= c;
        } catch {
          return b < 0 || a <= 0 || b + a > c;
        }
      }),
    );
  });
});

describe("classifyDeposit", () => {
  it("matches a deposit that exactly clears the open intakes", () => {
    expect(classifyDeposit({ depositMinor: 500, openIntakeTotalMinor: 500 })).toBe("matched");
  });

  it("classifies a deposit smaller than the open total as partial", () => {
    expect(classifyDeposit({ depositMinor: 300, openIntakeTotalMinor: 500 })).toBe("partial");
  });

  it("classifies any deposit over the open total as surplus", () => {
    expect(classifyDeposit({ depositMinor: 700, openIntakeTotalMinor: 500 })).toBe("surplus");
    expect(classifyDeposit({ depositMinor: 100, openIntakeTotalMinor: 0 })).toBe("surplus");
  });

  it("rejects non-positive deposits", () => {
    expect(() => classifyDeposit({ depositMinor: 0, openIntakeTotalMinor: 0 })).toThrow(CashError);
  });
});

describe("deposit deadlines", () => {
  const hour = 3_600_000;

  it("measures elapsed time between instants, not calendar days", () => {
    const recordedAt = new Date("2026-10-26T16:00:00Z");
    const now = new Date("2026-10-27T15:00:00Z");
    expect(depositAgeHours({ recordedAt, now })).toBe(23);
  });

  it("is overdue at the deadline boundary", () => {
    const recordedAt = new Date("2026-10-26T10:00:00Z");
    expect(
      isDepositOverdue({
        recordedAt,
        now: new Date("2026-10-27T09:59:00Z"),
        depositDeadlineHours: 24,
      }),
    ).toBe(false);
    expect(
      isDepositOverdue({
        recordedAt,
        now: new Date("2026-10-27T10:00:00Z"),
        depositDeadlineHours: 24,
      }),
    ).toBe(true);
  });

  it("does not care when the local clock is shifted by a DST change", () => {
    // Europe/Paris jumped from +01:00 to +02:00 in between; the elapsed time is
    // still 25 wall hours, so the deadline behaves identically either side.
    const recordedAt = new Date("2026-03-29T00:30:00Z");
    const now = new Date("2026-03-30T01:30:00Z");
    expect(depositAgeHours({ recordedAt, now })).toBe(25);
    expect(isDepositOverdue({ recordedAt, now, depositDeadlineHours: 24 })).toBe(true);
  });

  it("refuses a non-positive deadline", () => {
    expect(() =>
      isDepositOverdue({ recordedAt: new Date(), now: new Date(), depositDeadlineHours: 0 }),
    ).toThrow(CashError);
  });

  it("handles elapsed times that are not whole hours", () => {
    const recordedAt = new Date("2026-10-26T10:00:00Z");
    const now = new Date(recordedAt.getTime() + 23.5 * hour);
    expect(isDepositOverdue({ recordedAt, now, depositDeadlineHours: 24 })).toBe(false);
  });
});

describe("cash postings", () => {
  it("names the collector cash account as the funding source", () => {
    expect(COLLECTOR_CASH_ACCOUNT).toBe("COLLECTOR_CASH");
  });

  it("builds a balanced funding leg pair that attributes the collector", () => {
    const postings = cashFundingPostings(money("NGN", 500), { collectorUserId: "user-1" });
    expect(postings).toEqual([
      {
        accountCode: "COLLECTOR_CASH",
        direction: "debit",
        amount: money("NGN", 500),
        collectorUserId: "user-1",
      },
      { accountCode: "ASSET_WALLET", direction: "credit", amount: money("NGN", 500) },
    ]);
    expect(() => validateBalancedTransaction(postings)).not.toThrow();
  });

  it("omits the collector when the caller has none to attribute", () => {
    const postings = cashFundingPostings(money("NGN", 500));
    expect(postings[0]).toMatchObject({ accountCode: "COLLECTOR_CASH", direction: "debit" });
    expect(postings[0]?.collectorUserId).toBeUndefined();
  });

  it("mirroring preserves collector attribution and stays balanced", () => {
    const postings = cashFundingPostings(money("NGN", 500), { collectorUserId: "user-1" });
    const mirrored = mirrorPostings(postings);
    expect(
      mirrored
        .filter((posting) => posting.accountCode === "COLLECTOR_CASH")
        .map((posting) => posting.collectorUserId),
    ).toEqual(["user-1"]);
    // The asset wallet leg is deliberately not collector-attributed.
    expect(
      mirrored
        .filter((posting) => posting.accountCode === "ASSET_WALLET")
        .map((posting) => posting.collectorUserId),
    ).toEqual([undefined]);
    expect(() => validateBalancedTransaction(mirrored)).not.toThrow();
  });
});
