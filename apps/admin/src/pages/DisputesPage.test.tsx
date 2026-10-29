import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatTimestamp } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { DisputesPage } from "./DisputesPage.js";

/**
 * Disputes inbox with a stubbed global fetch.
 *
 * The inbox is read-only, so the tests pin what finance can see: the tenant's
 * business-day format, the status filter reaching the server as a real enum
 * value, the detail request, and the explicit "resolution is not available"
 * note. The last case is the negative one: without `dispute:read` the screen
 * renders the permission message and never asks the API for disputes.
 */

const config = loadFixtureConfig();

const openDispute = {
  id: "d-1",
  assetId: "as_1",
  openedByUserId: "officer-1",
  zoneId: "zone-1",
  clientDisputeId: "client-1",
  status: "open",
  reason: "wrong_vehicle",
  description: "The sticker belongs to another bike.",
  occurredAt: "2026-10-28T09:15:00.000Z",
  businessDate: "2026-10-28",
  recordedAt: "2026-10-28T09:16:00.000Z",
  latitude: "6.524400",
  longitude: "3.379200",
  resolutionNote: null,
  resolvedByUserId: null,
  resolvedAt: null,
  linkedPaymentId: null,
};

const resolvedDispute = {
  ...openDispute,
  id: "d-2",
  assetId: "as_2",
  status: "resolved",
  reason: "double_charge",
  description: "The driver was charged twice for the same day.",
  businessDate: "2026-10-27",
  recordedAt: "2026-10-27T10:00:00.000Z",
};

const evidence = {
  objectKey: "evidence/d-1.jpg",
  contentType: "image/jpeg",
  createdAt: "2026-10-28T09:17:00.000Z",
};

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
}

const requests: RecordedRequest[] = [];

const fakeFetch = vi.fn(async (input: unknown): Promise<Response> => {
  const url = new URL(urlOf(input), "http://localhost");
  // Duck-typed, not `instanceof Request`: vitest can hand the client a Request
  // from another realm than the one `globalThis.Request` points at.
  const request = typeof input === "string" ? undefined : (input as Request);
  requests.push({
    method: request?.method ?? "GET",
    path: url.pathname,
    search: url.search,
  });

  if ((request?.method ?? "GET") === "GET") {
    switch (url.pathname) {
      case "/v1/disputes": {
        const status = url.searchParams.get("status");
        const all = [openDispute, resolvedDispute];
        return json(200, {
          disputes: status === null ? all : all.filter((row) => row.status === status),
          nextCursor: null,
          hasMore: false,
        });
      }
      case "/v1/disputes/d-1":
        return json(200, { dispute: { ...openDispute, evidence: [evidence] } });
      case "/v1/tenants/current/config":
        return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
      default:
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
    }
  }

  return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
});

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage(permissions: readonly string[] = ["dispute:read"]): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "finance-1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["finance_admin"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DisputesPage />
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
  // globals are off in this package, so Testing Library never auto-cleans;
  // without this, renders accumulate and duplicate row text.
  cleanup();
  useSession.setState({
    status: "unknown",
    accessToken: undefined,
    user: undefined,
  });
  fakeFetch.mockClear();
  requests.length = 0;
});

describe("DisputesPage", () => {
  it("lists disputes with the tenant's business date, asset, reason and status", async () => {
    renderPage();

    // The tenant fixture renders business days as dd/MM/yyyy.
    expect(await screen.findByText("28/10/2026")).toBeTruthy();
    expect(screen.getByText("27/10/2026")).toBeTruthy();
    expect(screen.getByText("as_1")).toBeTruthy();
    expect(screen.getByText("wrong_vehicle")).toBeTruthy();
    expect(screen.getAllByText("zone-1")).toHaveLength(2);
    expect(screen.getByText("Open", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Resolved", { selector: "span" })).toBeTruthy();
    // The inbox opens on every status, so no status filter is sent.
    expect(requests.find((row) => row.path === "/v1/disputes")?.search).not.toContain("status=");
  });

  it("sends the chosen status filter and renders only matching rows", async () => {
    renderPage();
    expect(await screen.findByText("as_1")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "resolved" } });

    await waitFor(() => {
      expect(requests.filter((row) => row.path === "/v1/disputes").at(-1)?.search).toContain(
        "status=resolved",
      );
    });
    expect(await screen.findByText("as_2")).toBeTruthy();
    expect(screen.queryByText("as_1")).toBeNull();
  });

  it("loads the selected dispute's detail with evidence and the read-only note", async () => {
    renderPage();
    expect(await screen.findByText("as_1")).toBeTruthy();

    const open = screen.getAllByRole("button", { name: "View" });
    const first = open[0];
    if (first === undefined) throw new Error("no dispute row to open");
    fireEvent.click(first);

    expect(await screen.findByText("The sticker belongs to another bike.")).toBeTruthy();
    expect(
      screen.getByText(formatTimestamp(openDispute.occurredAt, "en-NG", "Africa/Lagos")),
    ).toBeTruthy();
    expect(screen.getByText(/evidence\/d-1\.jpg/)).toBeTruthy();
    expect(screen.getByText(/Read-only inbox/)).toBeTruthy();
    expect(screen.getByText(/Resolution is not available/)).toBeTruthy();
    // The detail is a request, not a client-side re-derivation of the row.
    expect(requests.some((row) => row.path === "/v1/disputes/d-1")).toBe(true);
  });

  it("shows the permission message and fires no dispute request without dispute:read", async () => {
    renderPage([]);

    expect(await screen.findByText("You do not have permission to view disputes.")).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/disputes"))).toBe(false);
  });
});
