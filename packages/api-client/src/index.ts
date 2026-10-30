import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema.gen.js";

export type ApiPaths = paths;
export { type components } from "./schema.gen.js";

export interface ApiErrorDetails {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

/**
 * The one error shape every route returns (the envelope from apps/api). The
 * dashboard renders both the message and — always — the request ID, so finance
 * can quote it against server logs.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(details: ApiErrorDetails) {
    super(details.message);
    this.name = "ApiError";
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

interface Envelope {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

function readEnvelope(body: unknown): Envelope | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  return error;
}

export function isApiEnvelope(body: unknown): body is { error: Record<string, unknown> } {
  return readEnvelope(body) !== undefined;
}

/** Builds an ApiError from either a parsed error body or a bare Response. */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    const text = await response.clone().text();
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  const envelope = readEnvelope(body);
  const requestId = typeof envelope?.requestId === "string" ? envelope.requestId : undefined;
  return new ApiError({
    status: response.status,
    code: typeof envelope?.code === "string" ? envelope.code : "error",
    message:
      typeof envelope?.message === "string"
        ? envelope.message
        : `Request failed with status ${String(response.status)}`,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export interface ApiClientOptions {
  /** Base URL; the dashboard uses a same-origin path that proxies to the API. */
  readonly baseUrl: string;
  /** Reads the in-memory access token (D26): never persisted, never in a URL. */
  readonly getAccessToken?: () => string | undefined;
  /** Namespace for generated idempotency keys, e.g. `dashboard`. */
  readonly idempotencyKeyPrefix?: string;
  /** Injectable fetch (tests); defaults to the runtime fetch set by setRuntimeFetch. */
  readonly fetch?: typeof fetch;
  /**
   * Fetch credentials mode. Defaults to `same-origin`: the D26 refresh token
   * travels in an httpOnly cookie, and the browser only stores a `Set-Cookie`
   * when the request that produced it was not `omit` (omit suppresses storage,
   * not just sending). A cross-origin client can pass `include` or `omit`.
   */
  readonly credentials?: "omit" | "same-origin" | "include";
  /**
   * POST paths that create or move money are keyed automatically (build brief
   * section 7). The default guards payment resolution; callers may widen.
   */
  readonly moneyPostMatches?: (path: string) => boolean;
}

let runtimeFetch: typeof globalThis.fetch = globalThis.fetch;

/**
 * Replaces the fetch used by clients created without an explicit one.
 *
 * `openapi-fetch` captures `fetch` at `createClient()` time, and a vitest setup
 * file runs after this module is evaluated but may run after the dashboard's
 * singleton client is constructed. Swapping `globalThis.fetch` would therefore
 * come too late, so the default is a wrapper that dereferences `runtimeFetch`
 * on each call instead of capturing it.
 */
export function setRuntimeFetch(fetchImpl: typeof globalThis.fetch): void {
  runtimeFetch = fetchImpl;
}

const defaultMoneyPostMatches = (path: string): boolean =>
  // Money-affecting POSTs: suspense resolution, collector cash intake,
  // deposit matching, intake reversal and deposit-instruction provisioning.
  // Every one of them creates or moves money, so the client must stamp an
  // Idempotency-Key before the request leaves the browser (ADR 0031).
  [
    "^/v1/payments/[^/]+/resolve/?$",
    "^/v1/cash/intakes/?$",
    "^/v1/cash/intakes/[^/]+/reverse/?$",
    "^/v1/cash/deposits/[^/]+/match/?$",
    "^/v1/cash/collectors/[^/]+/deposit-instruction/?$",
    "^/v1/cash/wallets/[^/]+/(freeze|unfreeze)/?$",
  ].some((pattern) => new RegExp(pattern).test(path));

/**
 * Creates the typed API client. Attachments applied here and nowhere else:
 * the bearer token, and idempotency keys on money-affecting POSTs.
 */
export function createApiClient(options: ApiClientOptions) {
  const moneyPostMatches = options.moneyPostMatches ?? defaultMoneyPostMatches;
  const fetchImpl: typeof globalThis.fetch = options.fetch ?? ((...args) => runtimeFetch(...args));
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    // `same-origin` (not `omit`): the refresh cookie must be *stored*, and a
    // request made with `credentials: "omit"` makes the browser discard the
    // response's Set-Cookie entirely — every reload then refreshed without a
    // cookie and signed the user out (D26).
    credentials: options.credentials ?? "same-origin",
    fetch: fetchImpl,
  });
  const middleware: Middleware = {
    onRequest({ request }) {
      const token = options.getAccessToken?.();
      if (token !== undefined && token !== "") {
        request.headers.set("authorization", `Bearer ${token}`);
      }
      if (
        request.method === "POST" &&
        moneyPostMatches(new URL(request.url, options.baseUrl || "http://localhost").pathname)
      ) {
        // Idempotency-Key is set before the request leaves the client, so a
        // retry, a double click, or a replayed queue entry can never double
        // resolve a suspense payment.
        request.headers.set("idempotency-key", idempotencyKey(options.idempotencyKeyPrefix));
      }
      return request;
    },
  };
  client.use(middleware);
  return client;
}

function idempotencyKey(prefix?: string): string {
  const key = globalThis.crypto.randomUUID();
  return prefix === undefined || prefix === "" ? key : `${prefix}-${key}`;
}

const retriedRequests = new WeakSet<Request>();

/**
 * D26 silent re-login: on the first 401 of an idempotent (GET) request, run one
 * refresh and replay it with the new bearer. POSTs are never replayed here
 * (media types, bodies, and money semantics make that the caller's decision).
 * Auth routes are exempt — refreshing on the refresh route would loop.
 * `fetch` is injectable so tests can drive the replay deterministically.
 */
export function refreshOnUnauthorized(options: {
  readonly refresh: () => Promise<void>;
  readonly getAccessToken: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
}): Middleware {
  const replayFetch = options.fetch ?? globalThis.fetch;
  return {
    async onResponse({ request, response }) {
      if (
        response.status !== 401 ||
        retriedRequests.has(request) ||
        request.method !== "GET" ||
        new URL(request.url).pathname.startsWith("/v1/auth/")
      ) {
        return response;
      }
      retriedRequests.add(request);
      await options.refresh();
      const token = options.getAccessToken();
      const headers = new Headers(request.headers);
      if (token !== undefined) {
        headers.set("authorization", `Bearer ${token}`);
      } else {
        headers.delete("authorization");
      }
      const replay = new Request(request, { headers });
      return await replayFetch(replay);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
