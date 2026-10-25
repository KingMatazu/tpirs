import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveOfflineScan } from "./resolver.js";

describe("field offline resolver", () => {
  it("never returns unpaid or other values", () => {
    const result = resolveOfflineScan("abcdef0123456789.SIG16", new Set());
    expect(result).toBe("not_in_offline_list");
    expect(result).not.toBe("unpaid");
    expect(result).not.toBe("NO_PAYMENT_RECORDED");
  });

  it("property test - only paid or not_in_offline_list or undefined", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 16, maxLength: 64 }).filter((v) => /^[A-Za-z0-9_-]+$/.test(v)),
        fc.array(fc.string(), { maxLength: 5 }),
        (payload, paid) => {
          const result = resolveOfflineScan(`${payload}.SIG16`, new Set(paid));
          return result === undefined || result === "paid" || result === "not_in_offline_list";
        },
      ),
    );
  });
});
