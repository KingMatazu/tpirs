import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isPaymentStatus,
  paymentStatusFromPeriod,
  readQrPayload,
  resolveOfflineScan,
} from "./verification.js";

describe("paymentStatusFromPeriod", () => {
  it("maps paid periods, including waivers, to paid", () => {
    expect(paymentStatusFromPeriod("paid")).toBe("paid");
    expect(paymentStatusFromPeriod("waived")).toBe("paid");
  });

  it("treats no row and unpaid as no payment recorded, not a debt", () => {
    expect(paymentStatusFromPeriod("none")).toBe("no_payment_recorded");
    expect(paymentStatusFromPeriod("unpaid")).toBe("no_payment_recorded");
  });

  it("reserves unknown for an unavailable ledger", () => {
    expect(paymentStatusFromPeriod(undefined)).toBe("unknown");
  });

  it("guards the wire vocabulary", () => {
    expect(isPaymentStatus("paid")).toBe(true);
    expect(isPaymentStatus("no_payment_recorded")).toBe(true);
    expect(isPaymentStatus("unpaid")).toBe(false);
  });
});

describe("readQrPayload", () => {
  it("splits a structurally valid token", () => {
    expect(readQrPayload("abcdef0123456789.SIG16")).toBe("abcdef0123456789");
  });

  it("returns undefined for malformed tokens instead of inventing a status", () => {
    expect(readQrPayload("noseparator")).toBeUndefined();
    expect(readQrPayload(".SIG16")).toBeUndefined();
    expect(readQrPayload("abcdef0123456789.")).toBeUndefined();
    expect(readQrPayload("abcdef0123456789.bad checksum")).toBeUndefined();
    expect(readQrPayload("short.SIG16")).toBeUndefined();
  });

  it("does not verify authenticity: a forged checksum still yields the payload", () => {
    // The field app may use the payload for a membership lookup only. It must
    // never treat this as proof that the sticker is genuine.
    expect(readQrPayload("abcdef0123456789.FORGED")).toBe("abcdef0123456789");
  });
});

describe("resolveOfflineScan", () => {
  const token = "abcdef0123456789.SIG16";

  it("confirms payment from the cached paid set", () => {
    expect(resolveOfflineScan(token, new Set(["abcdef0123456789"]))).toBe("paid");
  });

  it("reports absence as membership, never as unpaid", () => {
    expect(resolveOfflineScan(token, new Set())).toBe("not_in_offline_list");
    expect(resolveOfflineScan(token, new Set(["another-payload-000"]))).toBe("not_in_offline_list");
  });

  it("asks for a rescan when the token cannot be read", () => {
    expect(resolveOfflineScan("garbage", new Set())).toBeUndefined();
  });

  it("can only ever produce the two offline results", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 16, maxLength: 64 })
          .filter((value) => /^[A-Za-z0-9_-]+$/.test(value)),
        fc.array(fc.string(), { maxLength: 10 }),
        (payload, paid) => {
          const result = resolveOfflineScan(`${payload}.SIG16`, new Set(paid));
          return result === "paid" || result === "not_in_offline_list" || result === undefined;
        },
      ),
    );
  });
});
