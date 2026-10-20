import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";

const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface Money {
  readonly amount: number;
  readonly currency: string;
}

export function money(currency: string, amount: number): Money {
  if (!ISO_CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(
      "invalid_currency",
      `Currency "${currency}" is not an uppercase ISO 4217 alphabetic code`,
    );
  }
  if (!Number.isInteger(amount)) {
    throw new InvalidMoneyError("non_integer_amount", `Amount ${amount} is not an integer`);
  }
  if (!Number.isSafeInteger(amount)) {
    throw new InvalidMoneyError(
      "unsafe_integer",
      `Amount ${amount} exceeds the safe integer range`,
    );
  }
  return { amount, currency };
}

export function zeroMoney(currency: string): Money {
  return money(currency, 0);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.amount + b.amount);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.amount - b.amount);
}

export function negateMoney(a: Money): Money {
  return money(a.currency, -a.amount);
}

export function multiplyMoney(a: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new InvalidMoneyError("non_integer_amount", `Factor ${factor} is not an integer`);
  }
  return money(a.currency, a.amount * factor);
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function isZeroMoney(a: Money): boolean {
  return a.amount === 0;
}

export function isPositiveMoney(a: Money): boolean {
  return a.amount > 0;
}

export function isNegativeMoney(a: Money): boolean {
  return a.amount < 0;
}
