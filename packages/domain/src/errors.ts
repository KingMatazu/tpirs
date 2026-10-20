export class DomainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly left: string;
  readonly right: string;

  constructor(left: string, right: string) {
    super(`Cannot combine money in ${left} with money in ${right}`);
    this.left = left;
    this.right = right;
  }
}

export type InvalidMoneyReason = "non_integer_amount" | "unsafe_integer" | "invalid_currency";

export class InvalidMoneyError extends DomainError {
  readonly reason: InvalidMoneyReason;

  constructor(reason: InvalidMoneyReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export class InvalidIdError extends DomainError {
  readonly idType: string;

  constructor(idType: string, message: string) {
    super(message);
    this.idType = idType;
  }
}

export class InvalidBusinessDateError extends DomainError {
  readonly value: string;

  constructor(value: string, message: string) {
    super(message);
    this.value = value;
  }
}
