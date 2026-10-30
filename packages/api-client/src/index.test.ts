import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  refreshOnUnauthorized,
  setRuntimeFetch,
  toApiError,
} from "./index.js";

/**
 * The client plumbing runs against a stubbed fetch: bearer attachment,
 * idempotency keys on money POSTs only, envelope parsing, and the D26
 * one-shot refresh replay for GETs. Node 24 exposes Request/Response globals.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  request: globalThis.Request;
}

type RuntimePost = (path: string, init: { body: unknown }) => Promise<unknown>;

/**
 * `schema.gen.ts` is generated from the live server (D28) and is still an
 * empty stub while the route schemas stabilise, so `openapi-fetch` has no
 * operations to type. These tests assert runtime plumbing (headers,
 * idempotency), so drive POSTs through a small shim instead of a fake contract.
 */
function post(client: ReturnType<typeof createApiClient>, path: string, body: unknown) {
  return (client.POST as unknown as RuntimePost)(path, { body });
}

function stubFetch(handler: (request: globalThis.Request) => Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const request =
      input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
    calls.push({ request });
    return handler(request);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe("api client request plumbing", () => {
  it("attaches idempotency keys on money POSTs and nothing else", async () => {
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => "tok-1",
      idempotencyKeyPrefix: "dash",
      fetch: stubbed,
    });
    await post(client, "/v1/payments/pay_1/resolve", { assetId: "as_1" });
    await post(client, "/v1/auth/login", {
      tenantSlug: "a",
      username: "b",
      password: "c",
    });

    const resolveCall = calls[0];
    const loginCall = calls[1];
    expect(resolveCall?.request.headers.get("idempotency-key") ?? "").toMatch(/^dash-/);
    expect(loginCall?.request.headers.get("idempotency-key")).toBe(null);
    expect(loginCall?.request.headers.get("authorization")).toBe("Bearer tok-1");
  });

  it("keys every cash money POST, including freeze and provisioning", async () => {
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const client = createApiClient({
      baseUrl: "http://api.test",
      idempotencyKeyPrefix: "dash",
      fetch: stubbed,
    });
    const moneyPaths = [
      "/v1/cash/intakes",
      "/v1/cash/intakes/in_1/reverse",
      "/v1/cash/deposits/dp_1/match",
      "/v1/cash/collectors/u_1/deposit-instruction",
      "/v1/cash/wallets/u_1/freeze",
      "/v1/cash/wallets/u_1/unfreeze",
    ];
    for (const path of moneyPaths) {
      await post(client, path, {});
    }
    expect(calls).toHaveLength(moneyPaths.length);
    for (const call of calls) {
      expect(call.request.headers.get("idempotency-key") ?? "").toMatch(/^dash-/);
    }

    // A read-only cash route is not a money POST.
    const { fetch: readStub, calls: readCalls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const readClient = createApiClient({ baseUrl: "http://api.test", fetch: readStub });
    await readClient.GET("/v1/cash/wallets");
    expect(readCalls[0]?.request.headers.get("idempotency-key")).toBe(null);
  });

  it("keys money POSTs uniquely per call", async () => {
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://api.test", fetch: stubbed });
    await post(client, "/v1/payments/pay_1/resolve", { assetId: "as_1" });
    await post(client, "/v1/payments/pay_1/resolve", { assetId: "as_1" });
    expect(calls[0]?.request.headers.get("idempotency-key")).not.toBe(
      calls[1]?.request.headers.get("idempotency-key"),
    );
  });

  it("attaches the bearer token from the session store", async () => {
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const client = createApiClient({
      baseUrl: "http://api.test",
      getAccessToken: () => "tok-1",
      fetch: stubbed,
    });
    await client.GET("/v1/auth/me");
    expect(calls[0]?.request.headers.get("authorization")).toBe("Bearer tok-1");
  });

  it("keeps same-origin credentials so the refresh cookie is stored", async () => {
    // `credentials: "omit"` makes the browser discard Set-Cookie entirely, so
    // the D26 refresh cookie never reached the jar and every reload signed the
    // user out. Same-origin is the default; the option stays overridable.
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://api.test", fetch: stubbed });
    await post(client, "/v1/auth/login", { tenantSlug: "a", username: "b", password: "c" });
    expect(calls[0]?.request.credentials).toBe("same-origin");

    const { fetch: includeStub, calls: includeCalls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const includeClient = createApiClient({
      baseUrl: "https://api.test",
      credentials: "include",
      fetch: includeStub,
    });
    await includeClient.GET("/v1/auth/me");
    expect(includeCalls[0]?.request.credentials).toBe("include");
  });
});

describe("runtime fetch", () => {
  it("uses a fetch installed after the client was created", async () => {
    const client = createApiClient({ baseUrl: "http://api.test" });
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    setRuntimeFetch(stubbed);
    try {
      await client.GET("/v1/auth/me");
      expect(calls).toHaveLength(1);
    } finally {
      setRuntimeFetch(globalThis.fetch);
    }
  });

  it("prefers an explicitly injected fetch over the runtime one", async () => {
    const { fetch: stubbed, calls } = stubFetch(
      async () => new globalThis.Response("{}", { status: 200 }),
    );
    const runtime = stubFetch(async () => new globalThis.Response("{}", { status: 200 }));
    setRuntimeFetch(runtime.fetch);
    try {
      const client = createApiClient({ baseUrl: "http://api.test", fetch: stubbed });
      await client.GET("/v1/auth/me");
      expect(calls).toHaveLength(1);
      expect(runtime.calls).toHaveLength(0);
    } finally {
      setRuntimeFetch(globalThis.fetch);
    }
  });
});

describe("error envelope", () => {
  it("parses the standard envelope into an ApiError", async () => {
    const response = jsonResponse(403, {
      error: { code: "forbidden", message: "Missing permission", requestId: "req-1" },
    });
    const error = await toApiError(response);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Missing permission");
    expect(error.requestId).toBe("req-1");
  });

  it("falls back to a generic message on non-JSON error bodies", async () => {
    const response = new globalThis.Response("bad gateway", { status: 502 });
    const error = await toApiError(response);
    expect(error.code).toBe("error");
    expect(error.message).toContain("502");
    expect(error.requestId).toBeUndefined();
  });
});

describe("refreshOnUnauthorized", () => {
  it("refreshes once and replays a GET that came back 401", async () => {
    const refresh = vi.fn(async () => undefined);
    let replayedSawToken: string | null = null;
    const replayFetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const retried =
        input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
      replayedSawToken = retried.headers.get("authorization");
      return jsonResponse(200, { payments: [] });
    }) as unknown as typeof globalThis.fetch;

    const middleware = refreshOnUnauthorized({
      refresh,
      getAccessToken: () => "tok-2",
      fetch: replayFetch,
    });

    const replayed = await middleware.onResponse?.({
      request: new globalThis.Request("http://api.test/v1/payments"),
      response: jsonResponse(401, {
        error: { code: "unauthorized", message: "expired", requestId: "r" },
      }),
    } as never);
    expect(replayed?.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replayedSawToken).toBe("Bearer tok-2");
  });

  it("does not refresh on auth routes (would loop)", async () => {
    const refresh = vi.fn(async () => undefined);
    const middleware = refreshOnUnauthorized({ refresh, getAccessToken: () => undefined });
    const response = jsonResponse(401, {
      error: { code: "unauthorized", message: "x", requestId: "r" },
    });
    const replayed = await middleware.onResponse?.({
      request: new globalThis.Request("http://api.test/v1/auth/me"),
      response,
    } as never);
    expect(replayed?.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("never replays POSTs", async () => {
    const refresh = vi.fn(async () => undefined);
    const middleware = refreshOnUnauthorized({ refresh, getAccessToken: () => "t" });
    const response = jsonResponse(401, {
      error: { code: "unauthorized", message: "x", requestId: "r" },
    });
    const replayed = await middleware.onResponse?.({
      request: new globalThis.Request("http://api.test/v1/payments/p/resolve", {
        method: "POST",
        body: JSON.stringify({ assetId: "a" }),
      }),
      response,
    } as never);
    expect(replayed?.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });
});
