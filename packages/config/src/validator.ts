import { TenantConfigError } from "./errors.js";

/** A validation context that accumulates issues instead of throwing eagerly. */
export class Validator {
  readonly #issues: TenantConfigError[];
  private readonly basePath: string;

  constructor(basePath = "", issues?: TenantConfigError[]) {
    this.basePath = basePath;
    this.#issues = issues ?? [];
  }

  #path(key: string): string {
    return this.basePath === "" ? key : `${this.basePath}.${key}`;
  }

  issue(reason: TenantConfigError["reason"], message: string, key: string): void {
    this.#issues.push(new TenantConfigError(reason, message, this.#path(key)));
  }

  /** A child validator that shares this one's issue list so paths stay absolute. */
  child(key: string): Validator {
    return new Validator(this.#path(key), this.#issues);
  }

  /** Ensures the value is a plain object; returns it narrowed, or undefined. */
  object(value: unknown, key: string): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.issue("schema_error", `${this.#path(key)} must be an object`, key);
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  string(value: unknown, key: string): string | undefined {
    if (typeof value !== "string" || value.trim() === "") {
      this.issue("schema_error", `${this.#path(key)} must be a non-empty string`, key);
      return undefined;
    }
    return value;
  }

  boolean(value: unknown, key: string): boolean | undefined {
    if (typeof value !== "boolean") {
      this.issue("schema_error", `${this.#path(key)} must be a boolean`, key);
      return undefined;
    }
    return value;
  }

  integer(
    value: unknown,
    key: string,
    options: { min?: number; max?: number } = {},
  ): number | undefined {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.issue("schema_error", `${this.#path(key)} must be an integer`, key);
      return undefined;
    }
    if (options.min !== undefined && value < options.min) {
      this.issue("schema_error", `${this.#path(key)} must be >= ${options.min}`, key);
      return undefined;
    }
    if (options.max !== undefined && value > options.max) {
      this.issue("schema_error", `${this.#path(key)} must be <= ${options.max}`, key);
      return undefined;
    }
    return value;
  }

  enum<T extends string>(value: unknown, key: string, allowed: readonly T[]): T | undefined {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.issue("schema_error", `${this.#path(key)} must be one of: ${allowed.join(", ")}`, key);
      return undefined;
    }
    return value as T;
  }

  array(value: unknown, key: string): readonly unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.issue("schema_error", `${this.#path(key)} must be an array`, key);
      return undefined;
    }
    return value as unknown[];
  }

  /** Runs fn for each array item, carrying the numeric index in the path. */
  each(value: unknown, key: string, fn: (item: unknown, itemPath: string) => void): void {
    const items = this.array(value, key);
    if (items === undefined) return;
    items.forEach((item, index) => {
      fn(item, `${this.#path(key)}.${index}`);
    });
  }

  push(error: TenantConfigError): void {
    this.#issues.push(error);
  }

  get issues(): readonly TenantConfigError[] {
    return this.#issues;
  }
}
