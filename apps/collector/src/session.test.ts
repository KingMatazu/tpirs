import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client.js";

vi.mock("./api/client.js", () => ({
  api: { POST: vi.fn(), GET: vi.fn() },
  setCollectorToken: vi.fn(),
}));

/**
 * The store keeps its bootstrap promise in module scope, so each test imports a
 * fresh copy of the module rather than sharing one.
 */
async function freshSession(): Promise<typeof import("./session.js").useSession> {
  vi.resetModules();
  const module = await import("./session.js");
  return module.useSession;
}

function meResponse(): { readonly response: Response; readonly data: unknown } {
  return {
    response: new Response(null, { status: 200 }),
    data: {
      userId: "u-1",
      tenantId: "t-1",
      displayName: "Collector",
      permissions: ["cash:manage"],
    },
  };
}

describe("session bootstrap", () => {
  beforeEach(() => {
    vi.mocked(api.POST).mockReset();
    vi.mocked(api.GET).mockReset();
  });

  it("refreshes once when two callers start at the same time", async () => {
    vi.mocked(api.POST).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      data: { token: "access-token" },
    } as never);
    vi.mocked(api.GET).mockResolvedValue(meResponse() as never);

    const session = await freshSession();
    // React StrictMode mounts an effect twice; two refreshes would rotate the
    // refresh token twice and the loser would sign the user out.
    await Promise.all([session.getState().initialize(), session.getState().initialize()]);

    expect(vi.mocked(api.POST)).toHaveBeenCalledTimes(1);
    expect(session.getState().status).toBe("authenticated");
  });

  it("does not refresh again once the session is known", async () => {
    vi.mocked(api.POST).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      data: { token: "access-token" },
    } as never);
    vi.mocked(api.GET).mockResolvedValue(meResponse() as never);

    const session = await freshSession();
    await session.getState().initialize();
    await session.getState().initialize();

    expect(vi.mocked(api.POST)).toHaveBeenCalledTimes(1);
  });

  it("lands on the sign-in screen when there is no refresh cookie", async () => {
    vi.mocked(api.POST).mockResolvedValue({
      response: new Response(null, { status: 401 }),
      error: { error: { code: "unauthorized" } },
    } as never);

    const session = await freshSession();
    await session.getState().initialize();

    expect(session.getState().status).toBe("anonymous");
    expect(vi.mocked(api.GET)).not.toHaveBeenCalled();
  });

  it("does not resurrect a signed-out session on a later mount", async () => {
    vi.mocked(api.POST).mockResolvedValue({
      response: new Response(null, { status: 200 }),
      data: { token: "access-token" },
    } as never);
    vi.mocked(api.GET).mockResolvedValue(meResponse() as never);

    const session = await freshSession();
    await session.getState().initialize();
    await session.getState().logout();
    // A remount must not quietly sign the collector back in.
    await session.getState().initialize();

    expect(session.getState().status).toBe("anonymous");
    expect(vi.mocked(api.POST)).toHaveBeenCalledTimes(2); // refresh, then logout
  });
});
