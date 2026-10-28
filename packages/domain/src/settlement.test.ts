import { describe, expect, it } from "vitest";
import {
  InvalidSettlementRowError,
  parseSettlementAmountMinor,
  parseSettlementDate,
  settlementRowKey,
} from "./settlement.js";

const decimal = { amountInMinorUnits: false, decimalSeparator: "." } as const;
const commaDecimal = { amountInMinorUnits: false, decimalSeparator: "," } as const;
const minorUnits = { amountInMinorUnits: true, decimalSeparator: "." } as const;

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidSettlementRowError) return error.reason;
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("parseSettlementAmountMinor", () => {
  it("reads a decimal amount into minor units", () => {
    expect(parseSettlementAmountMinor("500.00", decimal)).toBe(50_000n);
    expect(parseSettlementAmountMinor("500", decimal)).toBe(50_000n);
    expect(parseSettlementAmountMinor("500.5", decimal)).toBe(50_050n);
    expect(parseSettlementAmountMinor("0.01", decimal)).toBe(1n);
  });

  it("removes grouping marks in either convention", () => {
    expect(parseSettlementAmountMinor("1,234.56", decimal)).toBe(123_456n);
    expect(parseSettlementAmountMinor("1.234,56", commaDecimal)).toBe(123_456n);
    expect(parseSettlementAmountMinor("1 234.56", decimal)).toBe(123_456n);
    expect(parseSettlementAmountMinor("1'234.56", decimal)).toBe(123_456n);
  });

  it("reads a minor-unit column as an integer", () => {
    expect(parseSettlementAmountMinor("50000", minorUnits)).toBe(50_000n);
    expect(reasonOf(() => parseSettlementAmountMinor("500.00", minorUnits))).toBe(
      "not_minor_units",
    );
  });

  it("refuses values it cannot represent exactly", () => {
    expect(reasonOf(() => parseSettlementAmountMinor("", decimal))).toBe("empty");
    expect(reasonOf(() => parseSettlementAmountMinor("-500.00", decimal))).toBe("negative");
    expect(reasonOf(() => parseSettlementAmountMinor("500.001", decimal))).toBe(
      "too_many_decimals",
    );
    expect(reasonOf(() => parseSettlementAmountMinor("five hundred", decimal))).toBe("not_numeric");
    expect(reasonOf(() => parseSettlementAmountMinor("1.2.3", decimal))).toBe(
      "too_many_separators",
    );
  });

  it("ignores a leading plus and surrounding whitespace", () => {
    expect(parseSettlementAmountMinor("  +500.00 ", decimal)).toBe(50_000n);
  });
});

describe("parseSettlementDate", () => {
  it("parses the supported date shapes as UTC", () => {
    expect(parseSettlementDate("2026-03-04", "YYYY-MM-DD").toISOString()).toBe(
      "2026-03-04T00:00:00.000Z",
    );
    expect(parseSettlementDate("04/03/2026", "DD/MM/YYYY").toISOString()).toBe(
      "2026-03-04T00:00:00.000Z",
    );
    expect(parseSettlementDate("03/04/2026", "MM/DD/YYYY").toISOString()).toBe(
      "2026-03-04T00:00:00.000Z",
    );
    expect(parseSettlementDate("2026-03-04 09:15:30", "YYYY-MM-DD HH:mm:ss").toISOString()).toBe(
      "2026-03-04T09:15:30.000Z",
    );
    expect(parseSettlementDate("04/03/2026 09:15:30", "DD/MM/YYYY HH:mm:ss").toISOString()).toBe(
      "2026-03-04T09:15:30.000Z",
    );
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(reasonOf(() => parseSettlementDate("2026-02-30", "YYYY-MM-DD"))).toBe("impossible_date");
    expect(reasonOf(() => parseSettlementDate("2026-13-01", "YYYY-MM-DD"))).toBe("impossible_date");
    expect(reasonOf(() => parseSettlementDate("2026-03-04 24:00:00", "YYYY-MM-DD HH:mm:ss"))).toBe(
      "bad_time",
    );
    expect(reasonOf(() => parseSettlementDate("04-03-2026", "DD/MM/YYYY"))).toBe("bad_date");
  });
});

describe("settlementRowKey", () => {
  const row = {
    providerReference: "PSK-123",
    amountMinor: 50_000n,
    feeMinor: 250n,
    currency: "NGN",
    settledAt: new Date("2026-03-04T00:00:00.000Z"),
  };

  it("is stable for identical values", () => {
    expect(settlementRowKey(row)).toBe(settlementRowKey({ ...row }));
  });

  it("separates rows that differ in any money field", () => {
    const keys = new Set([
      settlementRowKey(row),
      settlementRowKey({ ...row, amountMinor: 50_001n }),
      settlementRowKey({ ...row, feeMinor: 251n }),
      settlementRowKey({ ...row, currency: "USD" }),
      settlementRowKey({ ...row, settledAt: new Date("2026-03-05T00:00:00.000Z") }),
    ]);
    expect(keys.size).toBe(5);
  });

  it("cannot be confused by punctuation inside a reference", () => {
    expect(settlementRowKey({ ...row, providerReference: 'A"|B' })).not.toBe(
      settlementRowKey({ ...row, providerReference: 'A"|C' }),
    );
  });
});
