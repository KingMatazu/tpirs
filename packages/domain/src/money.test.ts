import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  money,
  moneyEquals,
  multiplyMoney,
  negateMoney,
  subtractMoney,
  zeroMoney,
} from "./money.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";

describe("money", () => {
  it("creates money from an integer minor-unit amount and ISO currency", () => {
    expect(money("NGN", 50_00)).toEqual({ amount: 5000, currency: "NGN" });
    expect(money("USD", 0)).toEqual({ amount: 0, currency: "USD" });
  });

  it("rejects non-integer amounts", () => {
    expect(() => money("NGN", 10.5)).toThrow(InvalidMoneyError);
    try {
      money("NGN", 10.5);
    } catch (error) {
      expect((error as InvalidMoneyError).reason).toBe("non_integer_amount");
    }
  });

  it("rejects unsafe integer amounts", () => {
    expect(() => money("NGN", Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidMoneyError);
  });

  it("rejects malformed currency codes", () => {
    expect(() => money("ngn", 100)).toThrow(InvalidMoneyError);
    expect(() => money("N", 100)).toThrow(InvalidMoneyError);
    expect(() => money("NGN1", 100)).toThrow(InvalidMoneyError);
  });
});

describe("money arithmetic", () => {
  it("adds and subtracts within one currency", () => {
    const a = money("NGN", 1000);
    const b = money("NGN", 250);
    expect(addMoney(a, b)).toEqual(money("NGN", 1250));
    expect(subtractMoney(a, b)).toEqual(money("NGN", 750));
  });

  it("refuses to mix currencies", () => {
    expect(() => addMoney(money("NGN", 1), money("USD", 1))).toThrow(CurrencyMismatchError);
    expect(() => subtractMoney(money("NGN", 1), money("USD", 1))).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(money("NGN", 1), money("USD", 1))).toThrow(CurrencyMismatchError);
  });

  it("negates, multiplies, and reports sign", () => {
    expect(negateMoney(money("NGN", 700))).toEqual(money("NGN", -700));
    expect(multiplyMoney(money("NGN", 500), 3)).toEqual(money("NGN", 1500));
    expect(isZeroMoney(zeroMoney("NGN"))).toBe(true);
    expect(isPositiveMoney(money("NGN", 1))).toBe(true);
    expect(isNegativeMoney(money("NGN", -1))).toBe(true);
    expect(isPositiveMoney(money("NGN", -1))).toBe(false);
  });

  it("rejects non-integer multipliers", () => {
    expect(() => multiplyMoney(money("NGN", 100), 1.5)).toThrow(InvalidMoneyError);
  });

  it("compares and equals", () => {
    expect(compareMoney(money("NGN", 1), money("NGN", 2))).toBe(-1);
    expect(compareMoney(money("NGN", 2), money("NGN", 2))).toBe(0);
    expect(compareMoney(money("NGN", 3), money("NGN", 2))).toBe(1);
    expect(moneyEquals(money("NGN", 2), money("NGN", 2))).toBe(true);
    expect(moneyEquals(money("NGN", 2), money("USD", 2))).toBe(false);
  });
});
