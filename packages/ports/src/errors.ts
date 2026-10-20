export type PortErrorCode =
  | "unavailable"
  | "timeout"
  | "invalid_request"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "provider_error";

const RETRYABLE_BY_DEFAULT: ReadonlySet<PortErrorCode> = new Set([
  "unavailable",
  "timeout",
  "rate_limited",
]);

export interface PortErrorOptions {
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly provider?: string;
}

/**
 * Every adapter MUST surface external failures as PortError with a stable code.
 * Domain logic switches on `code`, never on vendor error shapes.
 */
export class PortError extends Error {
  readonly port: string;
  readonly code: PortErrorCode;
  readonly retryable: boolean;
  readonly provider: string | undefined;

  constructor(port: string, code: PortErrorCode, message: string, options: PortErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PortError";
    this.port = port;
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.provider = options.provider;
  }
}
