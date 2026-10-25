import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useSession } from "./session.js";
import { stubRelativeRequests } from "./test-support/browserStubs.js";

/**
 * Session store behavior with a stubbed global fetch (D26): in-memory bearer,
 * cookie-based silent refresh with credentials, fail-closed on any refresh
 * failure, and logout revoking then clearing the session.
 *
 * Response bodies mirror the D26 route contract in apps/api.
 */

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const calls: RecordedCall[] = [];
let responder: (url: string) => { status: number; body?: unknown } = () => ({ status: 401 });

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost").pathname;
  calls.push({ url, init: request });
  const outcome = responder(url);
  return new Response(outcome.body === undefined ? null : JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: { "content-type": "application/json" },
  });
});

const sessionBody = (token: string) => ({
  token,
  expiresAt: "2026-10-23T13:00:00.000Z",
  user: { userId: "u1", tenantId: "t1", displayName: "Ada", roles: ["finance_admin"] },
  refreshToken: "r-" + token,
  refreshExpiresAt: "2026-10-24T13:00:00.000Z",
});

const meBody = {
  userId: "u1",
  tenantId: "t1",
  displayName: "Ada",
  roles: ["finance_admin"],
  permissions: ["audit:read", "payment:read"],
};

function resetStore(): void {
  useSession.setState({
    status: "unknown",
    accessToken: undefined,
    user: undefined,
    initializing: false,
  });
  calls.length = 0;
  responder = () => ({ status: 401 });
}

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetStore();
});

describe("useSession", () => {
  it("logs in, then loads permissions from /me", async () => {
    responder = (url) => {
      if (url === "/v1/auth/login") return { status: 200, body: sessionBody("tok-login") };
      if (url === "/v1/auth/me") return { status: 200, body: meBody };
      return { status: 404 };
    };
    await useSession.getState().login({
      tenantSlug: "example-state",
      username: "ada",
      password: "correct horse",
    });
    expect(useSession.getState().status).toBe("authenticated");
    expect(useSession.getState().accessToken).toBe("tok-login");
    expect(useSession.getState().user?.permissions).toContain("audit:read");
    expect(calls.map((call) => call.url)).toEqual(["/v1/auth/login", "/v1/auth/me"]);
  });

  it("refresh posts no body and carries same-origin credentials", async () => {
    responder = (url) => {
      if (url === "/v1/auth/refresh") return { status: 200, body: sessionBody("tok-refresh") };
      if (url === "/v1/auth/me") return { status: 200, body: meBody };
      return { status: 404 };
    };
    useSession.setState({ status: "anonymous" });
    await useSession.getState().silentRefresh();
    expect(useSession.getState().accessToken).toBe("tok-refresh");
    const call = calls[calls.length - 1];
    expect(call?.url).toBe("/v1/auth/refresh");
    expect(call?.init?.credentials).toBe("same-origin");
    expect(call?.init?.body).toBeNull();
  });

  it("fails closed to anonymous when the refresh cookie is gone", async () => {
    useSession.setState({ status: "authenticated", accessToken: "stale" });
    responder = () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "No refresh", requestId: "r1" } },
    });
    await expect(useSession.getState().silentRefresh()).resolves.toBeUndefined();
    expect(useSession.getState().status).toBe("anonymous");
    expect(useSession.getState().accessToken).toBeUndefined();
  });

  it("logout revokes both sessions and clears the store", async () => {
    useSession.setState({
      status: "authenticated",
      accessToken: "tok",
      user: {
        userId: "u1",
        tenantId: "t1",
        displayName: "Ada",
        roles: [],
        permissions: [],
      },
    });
    responder = () => ({ status: 204 });
    await useSession.getState().logout();
    expect(calls.map((call) => call.url)).toEqual(["/v1/auth/logout"]);
    expect(useSession.getState().status).toBe("anonymous");
    expect(useSession.getState().accessToken).toBeUndefined();
  });

  it("clears the local session even if the server rejects logout", async () => {
    useSession.setState({ status: "authenticated", accessToken: "tok" });
    responder = () => ({ status: 500 });
    await useSession.getState().logout();
    expect(useSession.getState().status).toBe("anonymous");
  });
});
