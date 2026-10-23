import { describe, expect, it } from "vitest";
import {
  formatBusinessDate,
  formatMinor,
  minorUnitExponent,
  renderPlaceholders,
  renderReceiptSms,
  renderUnderpaymentNoticeSms,
} from "./receipt-renderer.js";

describe("renderPlaceholders", () => {
  it("substitutes every occurrence of a placeholder", () => {
    expect(renderPlaceholders("{a} and {a} and {b}", { a: "1", b: "2" })).toBe("1 and 1 and 2");
  });

  it("leaves an unknown placeholder alone rather than blanking it", () => {
    expect(renderPlaceholders("{a} {unknown}", { a: "1" })).toBe("1 {unknown}");
  });

  it("does not treat replacement text as a pattern", () => {
    // A value containing `$&` would corrupt output with String.replace.
    expect(renderPlaceholders("{a}", { a: "$& $1" })).toBe("$& $1");
  });
});

describe("minorUnitExponent", () => {
  it("reads the exponent from Intl instead of assuming two places", () => {
    expect(minorUnitExponent("NGN")).toBe(2);
    expect(minorUnitExponent("JPY")).toBe(0);
  });

  it("falls back to two places for a currency Intl does not know", () => {
    expect(minorUnitExponent("ZZZ")).toBe(2);
  });
});

describe("formatMinor", () => {
  it("renders minor units in the tenant's currency and locale", () => {
    const rendered = formatMinor(20_000n, "NGN", "en-NG");
    expect(rendered).toContain("200");
    expect(rendered).toContain("₦");
  });

  it("renders a zero-decimal currency without inventing decimals", () => {
    expect(formatMinor(500n, "JPY", "en-JP")).not.toContain(".");
  });
});

describe("formatBusinessDate", () => {
  it("honours a day-first tenant format", () => {
    expect(formatBusinessDate("2026-06-15", "en-GB", "dd/MM/yyyy")).toBe("15/06/2026");
  });

  it("honours a month-first tenant format", () => {
    expect(formatBusinessDate("2026-06-15", "en-US", "MM/dd/yyyy")).toBe("06/15/2026");
  });

  it("returns the ISO value when the date is unparseable", () => {
    expect(formatBusinessDate("not-a-date", "en-GB", "dd/MM/yyyy")).toBe("not-a-date");
  });
});

describe("renderReceiptSms", () => {
  const base = {
    template: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
    amountMinor: 20_000n,
    currency: "NGN",
    locale: "en-NG",
    dateFormat: "dd/MM/yyyy",
    assetRef: "KJA-123",
    receiptNumber: "R-1",
    businessDate: "2026-06-15",
  };

  it("fills every placeholder the tenant template declares", () => {
    const text = renderReceiptSms(base);
    expect(text).toContain("R-1");
    expect(text).toContain("KJA-123");
    expect(text).toContain("15/06/2026");
    expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it("uses the tenant template verbatim, so copy is never hardcoded", () => {
    const text = renderReceiptSms({ ...base, template: "Levy {amount} received ({receiptNo})." });
    expect(text.startsWith("Levy ")).toBe(true);
    expect(text).not.toContain("Receipt ");
  });
});

describe("renderUnderpaymentNoticeSms", () => {
  it("states the exact shortfall that is still due", () => {
    const text = renderUnderpaymentNoticeSms({
      shortfallMinor: 5_000n,
      currency: "NGN",
      locale: "en-NG",
      assetRef: "KJA-123",
      receiptHeader: "State Revenue",
    });
    expect(text).toContain("KJA-123");
    expect(text).toContain("State Revenue");
    expect(text).toContain(formatMinor(5_000n, "NGN", "en-NG"));
  });

  it("omits an empty branding header instead of leaving a gap", () => {
    const text = renderUnderpaymentNoticeSms({
      shortfallMinor: 5_000n,
      currency: "NGN",
      locale: "en-NG",
      assetRef: "KJA-123",
      receiptHeader: "   ",
    });
    expect(text.startsWith("Short payment")).toBe(true);
  });
});
