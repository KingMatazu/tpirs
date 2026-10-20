/**
 * Errors raised while loading or validating a tenant configuration. Messages
 * name the offending path so operators can fix the file without reading code.
 */
export type ConfigErrorReason =
  | "parse_error"
  | "schema_error"
  | "read_error"
  | "duplicate_key"
  | "unknown_provider"
  | "invalid_reference";

export class TenantConfigError extends Error {
  readonly reason: ConfigErrorReason;
  /** Dot-separated location within the config, e.g. "locale.timezone". Empty at the root. */
  readonly path: string;

  constructor(reason: ConfigErrorReason, message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TenantConfigError";
    this.reason = reason;
    this.path = path;
  }
}

/** Collects every validation problem so a load reports all issues at once. */
export class TenantConfigValidationError extends Error {
  readonly issues: readonly TenantConfigError[];

  constructor(issues: readonly TenantConfigError[]) {
    super(`Tenant configuration has ${issues.length} issue(s): ${issues.map((i) => i.message).join("; ")}`);
    this.name = "TenantConfigValidationError";
    this.issues = issues;
  }
}
