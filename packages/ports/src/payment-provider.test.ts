import { describe, expect, it } from "vitest";
import { isPaymentAttributionKind, PAYMENT_ATTRIBUTION_KINDS } from "./payment-provider.js";

describe("payment attribution kinds", () => {
  it("accepts every declared kind", () => {
    for (const kind of PAYMENT_ATTRIBUTION_KINDS) {
      expect(isPaymentAttributionKind(kind)).toBe(true);
    }
  });

  it("rejects values it does not declare", () => {
    expect(isPaymentAttributionKind("")).toBe(false);
    expect(isPaymentAttributionKind("Virtual_Account")).toBe(false);
    expect(isPaymentAttributionKind("bank_transfer")).toBe(false);
    expect(isPaymentAttributionKind("toString")).toBe(false);
  });

  it("declares each kind once", () => {
    expect(new Set(PAYMENT_ATTRIBUTION_KINDS).size).toBe(PAYMENT_ATTRIBUTION_KINDS.length);
  });
});
