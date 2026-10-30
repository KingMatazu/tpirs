import { describe, expect, it } from "vitest";
import { decideCollect, floatPercent, toBigInt, type WalletView } from "./flow.js";

const wallet = (overrides: Partial<WalletView> = {}): WalletView => ({
  collectorUserId: "collector-1",
  status: "active",
  frozenReason: null,
  floatCeilingMinor: "5000000",
  balanceMinor: "1800000",
  openIntakeTotalMinor: "1800000",
  oldestOpenIntakeAt: "2026-10-31T07:00:00.000Z",
  lastDepositAt: null,
  depositInstruction: null,
  ...overrides,
});

describe("decideCollect", () => {
  it("allows cash when nothing blocks it", () => {
    const decision = decideCollect({
      wallet: wallet(),
      paymentStatus: "no_payment_recorded",
      feeMinor: 100000n,
      online: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.floatLeftMinor).toBe(1800000n);
  });

  it("blocks a frozen wallet first, whatever else is true", () => {
    const decision = decideCollect({
      wallet: wallet({ status: "frozen", frozenReason: "shortfall" }),
      paymentStatus: "paid",
      feeMinor: 100000n,
      online: false,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "frozen" });
  });

  it("blocks a vehicle that has already paid today", () => {
    const decision = decideCollect({
      wallet: wallet(),
      paymentStatus: "paid",
      feeMinor: 100000n,
      online: true,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "already_paid" });
  });

  it("blocks when the cash in hand cannot cover the fee", () => {
    const decision = decideCollect({
      wallet: wallet({ balanceMinor: "50000" }),
      paymentStatus: "no_payment_recorded",
      feeMinor: 100000n,
      online: true,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "float_low" });
  });

  it("blocks offline: cash is only recorded when the ledger can post it", () => {
    const decision = decideCollect({
      wallet: wallet(),
      paymentStatus: "no_payment_recorded",
      feeMinor: 100000n,
      online: false,
    });
    expect(decision).toMatchObject({ allowed: false, reason: "offline" });
  });

  it("does not block on a zero fee", () => {
    const decision = decideCollect({
      wallet: wallet({ balanceMinor: "0" }),
      paymentStatus: "no_payment_recorded",
      feeMinor: 0n,
      online: true,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("floatPercent", () => {
  it("is the share of the ceiling the collector is carrying", () => {
    expect(floatPercent(wallet())).toBe(36);
  });

  it("is zero without a ceiling, and never above 100", () => {
    expect(floatPercent(wallet({ floatCeilingMinor: null }))).toBe(0);
    expect(floatPercent(wallet({ balanceMinor: "9000000" }))).toBe(100);
  });
});

describe("toBigInt", () => {
  it("reads the string amounts the API sends, and tolerates junk", () => {
    expect(toBigInt("20000")).toBe(20000n);
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
    expect(toBigInt("not-a-number")).toBe(0n);
  });
});
