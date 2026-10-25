import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { AuditPage, auditQueryParams } from "./AuditPage.js";

/**
 * Audit screen with a stubbed global fetch: the cursor feed loads page 1,
 * "Load more" appends page 2 via the opaque cursor, and rows expand to show
 * before/after snapshots. The tenant config request (for timestamp rendering)
 * is served from the shared fixture.
 */

const config = loadFixtureConfig();

const pageOne = {
  entries: [
    {
      id: "a1",
      action: "asset.register",
      entityType: "asset",
      entityId: "as_1",
      actorUserId: "u1",
      before: null,
      after: { plate_number: "AB-123" },
      requestId: "req-1",
      ip: "127.0.0.1",
      createdAt: "2026-10-20T10:00:00.000Z",
    },
  ],
  nextCursor: "2026-10-20T10:00:00.000Z|a1",
};

const pageTwo = {
  entries: [
    {
      id: "a2",
      action: "tenant.config.update",
      entityType: "tenant",
      entityId: "t1",
      actorUserId: "u2",
      before: { reconciliation: { schedule: "0 1 * * *" } },
      after: { reconciliation: { schedule: "0 2 * * *" } },
      requestId: "req-2",
      ip: "127.0.0.1",
      createdAt: "2026-10-21T10:00:00.000Z",
    },
  ],
  nextCursor: null,
};

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  switch (url.pathname) {
    case "/v1/audit": {
      const page = url.searchParams.get("cursor") === null ? pageOne : pageTwo;
      return json(200, page);
    }
    case "/v1/tenants/current/config":
      return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["auditor"],
      permissions: ["audit:read"],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  useSession.setState({
    status: "unknown",
    accessToken: undefined,
    user: undefined,
  });
  fakeFetch.mockClear();
});

describe("AuditPage", () => {
  it("lists the first cursor page and expands a row's snapshots", async () => {
    renderPage();
    expect(await screen.findByText("asset.register")).toBeTruthy();
    expect(screen.queryByText("tenant.config.update")).toBeNull();

    fireEvent.click(screen.getAllByText("Details")[0] as HTMLElement);
    expect(await screen.findByText(/plate_number/)).toBeTruthy();
    expect(screen.getByText("req-1")).toBeTruthy();
  });

  it("loads the next page through the opaque cursor without losing page one", async () => {
    renderPage();
    expect(await screen.findByText("asset.register")).toBeTruthy();

    fireEvent.click(screen.getByText("Load more"));
    expect(await screen.findByText("tenant.config.update")).toBeTruthy();
    expect(screen.getByText("asset.register")).toBeTruthy();

    // Cursor exhausted: the Load more affordance disappears.
    await waitFor(() => {
      expect(screen.queryByText("Load more")).toBeNull();
    });
  });

  it("maps filters to the querystring, omitting empty values", () => {
    expect(auditQueryParams({}, undefined, 50)).toEqual({ limit: "50" });
    expect(
      auditQueryParams(
        {
          actor: "u1",
          kind: "",
          action: "asset.register",
          from: "",
          to: "2026-10-20",
        },
        "cursor-token",
        50,
      ),
    ).toEqual({
      limit: "50",
      cursor: "cursor-token",
      actor: "u1",
      action: "asset.register",
      to: "2026-10-20",
    });
  });
});
