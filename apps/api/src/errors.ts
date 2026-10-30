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
