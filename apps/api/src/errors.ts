export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export function errorEnvelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}

const STATUS_TO_CODE: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "unprocessable_entity",
  429: "rate_limited",
};

export function defaultErrorCode(statusCode: number): string {
  return STATUS_TO_CODE[statusCode] ?? (statusCode >= 500 ? "internal_error" : "error");
}

/**
 * What a client may see. A 4xx explains itself — the caller can act on it. A 5xx
 * does not: the message would leak SQL, table names or internal state, so it is
 * replaced with a generic one and the detail goes to telemetry with the request
 * id (Phase 10, Step 7).
 */
export function clientErrorMessage(error: unknown, statusCode: number): string {
  if (statusCode >= 500) return "Internal server error";
  return error instanceof Error ? error.message : "Request failed";
}

/**
 * SQLSTATEs that mean "this database does not have what this build expects":
 * undefined column (42703), undefined table (42P01), undefined function (42883)
 * and undefined object (42704).
 *
 * A pilot deployment applies migrations by hand from an operator's machine, so a
 * build can reach production ahead of its schema. The symptom is a bare
 * "Internal server error" on whichever route touched the new column — on the
 * first-run wizard that reads as "the product is broken", when the remedy is one
 * command.
 */
const SCHEMA_DRIFT_SQLSTATES = new Set(["42703", "42P01", "42883", "42704"]);

/** The SQLSTATE on a driver error, looking through one or two wrapper layers. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isSchemaDrift(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && SCHEMA_DRIFT_SQLSTATES.has(code);
}

/**
 * Says what an operator can do about it, without naming a table or a column: the
 * remedy is public, the SQL is not.
 */
export const SCHEMA_DRIFT_MESSAGE =
  "The database behind this deployment is behind this build. Apply the migrations " +
  "(pnpm --filter @tpirs/db migrate up) and try again.";
