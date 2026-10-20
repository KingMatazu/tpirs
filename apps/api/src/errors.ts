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
