import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { ReversalsPage } from "./ReversalsPage.js";

/**
 * Reversal queue with a stubbed global fetch.
 *
 * The workflow is the dual-approval one: read the pending request, approve it
 * with an optional note, or reject it with a reason. Both bodies are asserted
 * exactly because the server re-validates them. The two negative cases are the
 * point of the screen: an auditor (no `ledger:approve`) gets no controls, and a
 * requester is told a different finance user must decide — no POST leaves the
 * browser either time.
 */

const config = loadFixtureConfig();

const pendingReversal = {
  id: "rv-1",
  originalTransactionId: "tx-1",
  reason: "Driver paid twice",
  status: "pending" as "pending" | "approved" | "rejected",
  requestedByUserId: "requester-1",
  approvedByUserId: null as string | null,
  rejectedByUserId: null as string | null,
  approvedAt: null as string | null,
  rejectedAt: null as string | null,
  reversingTransactionId: null as string | null,
  createdAt: "2026-10-28T08:00:00.000Z",
};

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: string;
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
    body: request === undefined ? "" : await request.clone().text(),
  });
  const method = request?.method ?? "GET";

  if (method === "GET") {
    switch (url.pathname) {
      case "/v1/reversals": {
        const status = url.searchParams.get("status");
        return json(200, {
          reversals: status === null || status === pendingReversal.status ? [pendingReversal] : [],
        });
      }
      case "/v1/tenants/current/config":
        return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
      default:
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
    }
  }

  switch (url.pathname) {
    case "/v1/reversals/rv-1/approve":
      return json(200, {
        reversal: {
          ...pendingReversal,
          status: "approved",
          approvedByUserId: "finance-1",
          approvedAt: "2026-10-29T09:00:00.000Z",
          reversingTransactionId: "tx-2",
        },
        transactionId: "tx-2",
      });
    case "/v1/reversals/rv-1/reject":
      return json(200, {
        reversal: {
          ...pendingReversal,
          status: "rejected",
          rejectedByUserId: "finance-1",
          rejectedAt: "2026-10-29T09:00:00.000Z",
        },
      });
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
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

const FINANCE = ["ledger:read", "ledger:approve"];
const AUDITOR = ["ledger:read"];

function renderPage(permissions: readonly string[] = FINANCE, userId = "finance-1"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId,
      tenantId: "t1",
      displayName: "Ada",
      roles: ["finance_admin"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ReversalsPage />
    </QueryClientProvider>,
  );
}

function bodyOf(path: string, method: string): Record<string, unknown> | undefined {
  const found = requests.filter((row) => row.path === path && row.method === method).at(-1);
  return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>);
}

async function openRequest(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(await screen.findByText(/Reversal of transaction tx-1/)).toBeTruthy();
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

describe("ReversalsPage", () => {
  it("lists pending requests with the original transaction, reason and requester", async () => {
    renderPage();

    expect(await screen.findByText("tx-1")).toBeTruthy();
    expect(screen.getByText("Driver paid twice")).toBeTruthy();
    expect(screen.getByText("requester-1")).toBeTruthy();
    expect(screen.getByText("Pending", { selector: "span" })).toBeTruthy();
    // The queue opens on pending work only.
    expect(requests.find((row) => row.path === "/v1/reversals")?.search).toContain(
      "status=pending",
    );
  });

  it("approves a pending request with the trimmed note on the approve path", async () => {
    renderPage();
    await openRequest();

    fireEvent.input(screen.getByPlaceholderText("Approval note"), {
      target: { value: "  checked the statement  " },
    });
    fireEvent.click(screen.getByText("Approve reversal"));

    await waitFor(() => {
      expect(bodyOf("/v1/reversals/rv-1/approve", "POST")).toEqual({
        note: "checked the statement",
      });
    });
  });

  it("requires a rejection reason before it sends anything", async () => {
    renderPage();
    await openRequest();

    fireEvent.click(screen.getByText("Reject reversal"));
    expect(bodyOf("/v1/reversals/rv-1/reject", "POST")).toBeUndefined();

    fireEvent.input(screen.getByPlaceholderText("Rejection reason"), {
      target: { value: " no evidence of a double payment " },
    });
    fireEvent.click(screen.getByText("Reject reversal"));

    await waitFor(() => {
      expect(bodyOf("/v1/reversals/rv-1/reject", "POST")).toEqual({
        reason: "no evidence of a double payment",
      });
    });
  });

  it("tells the requester that a different finance user must decide, and sends nothing", async () => {
    renderPage(FINANCE, "requester-1");
    await openRequest();

    expect(
      screen.getByText(/You requested this reversal; a different finance user must approve/),
    ).toBeTruthy();
    expect(screen.queryByText("Approve reversal")).toBeNull();
    expect(screen.queryByText("Reject reversal")).toBeNull();
    expect(requests.filter((row) => row.method === "POST")).toHaveLength(0);
  });

  it("gives an auditor the queue but no approve or reject controls", async () => {
    renderPage(AUDITOR, "auditor-1");
    await openRequest();

    expect(
      screen.getByText(/approving or rejecting a reversal needs the ledger:approve permission/),
    ).toBeTruthy();
    expect(screen.queryByText("Approve reversal")).toBeNull();
    expect(screen.queryByText("Reject reversal")).toBeNull();
    expect(requests.filter((row) => row.method === "POST")).toHaveLength(0);
  });

  it("shows the permission message and fires no reversal request without ledger:read", async () => {
    renderPage([]);

    expect(
      await screen.findByText("You do not have permission to view reversal requests."),
    ).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/reversals"))).toBe(false);
  });
});
