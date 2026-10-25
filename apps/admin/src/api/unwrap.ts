import { ApiError } from "@tpirs/api-client";

/**
 * openapi-fetch returns `{ data, error, response }`; the dashboard treats the
 * parsed error envelope as the single failure shape and converts it to the
 * ApiError the toast host renders (message plus — always — the request ID).
 */
export interface ApiResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

export function errorFrom(result: ApiResult<unknown>): ApiError {
  const body = result.error;
  const envelope =
    typeof body === "object" && body !== null
      ? (body as { error?: Record<string, unknown> }).error
      : undefined;
  const requestId = typeof envelope?.["requestId"] === "string" ? envelope["requestId"] : undefined;
  const code = typeof envelope?.["code"] === "string" ? envelope["code"] : undefined;
  const message = typeof envelope?.["message"] === "string" ? envelope["message"] : undefined;
  return new ApiError({
    status: result.response.status,
    code: code ?? "error",
    message: message ?? `Request failed with status ${String(result.response.status)}`,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** Unwraps a client call, rejecting with the rendered-actionable ApiError. */
export async function unwrap<T>(result: Promise<ApiResult<T>> | ApiResult<T>): Promise<T> {
  const resolved = await result;
  if (resolved.error !== undefined && resolved.error !== null) {
    throw errorFrom(resolved);
  }
  return resolved.data as T;
}
