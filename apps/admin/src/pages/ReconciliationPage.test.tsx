import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { ReconciliationPage } from "./ReconciliationPage.js";

/**
 * Reconciliation screen with a stubbed global fetch.
 *
 * The workflow under test is the one finance performs: read the day's run and
 * its checklist, clear the exception queue with a note, then sign the day off
 * with a note. Both mutations carry a reason and are asserted exactly: the
 * contract has one field, and the server re-validates it.
 *
 * The auditor case is the other half of the acceptance check: the same data,
 * no mutation controls, and no POST ever leaves the browser.
 */

const config = loadFixtureConfig();

const run = {
  id: "run-1",
  businessDate: "2026-10-28",
  runSeq: 1,
  status: "completed" as const,
  toleranceMinor: "100",
  feeToleranceMinor: "1000",
  checklist: [
    {
      check: "ledger_balances",
      severity: "blocking" as const,
      subjectType: "tenant",
      subjectId: null,
      expectedMinor: "0",
      actualMinor: "0",
      expectedCount: null,
      actualCount: null,
      differenceMinor: "0",
      differenceCount: null,
      withinTolerance: true,
    },
    {
      check: "settlement_rows_matched",
      severity: "blocking" as const,
      subjectType: "provider",
      subjectId: "mock",
      expectedMinor: "20000",
      actualMinor: "20000",
      expectedCount: null,
      actualCount: null,
      differenceMinor: "0",
      differenceCount: null,
      withinTolerance: true,
    },
  ],
  exceptionCount: 1,
  failureReason: null,
  startedAt: "2026-10-28T02:00:00.000Z",
  completedAt: "2026-10-28T02:01:00.000Z",
  signedOffByUserId: null,
  signedOffAt: null,
  signOffNote: null,
};

const exception = {
  id: "ex-1",
  runId: "run-1",
  kind: "settlement_amounts",
  severity: "blocking" as const,
  status: "open" as const,
  subjectType: "provider",
  subjectId: "mock",
  businessDate: "2026-10-28",
  expectedMinor: "20000",
  actualMinor: "19800",
  differenceMinor: "200",
  currency: "NGN",
  detail: {},
  resolutionNote: null,
  resolvedByUserId: null,
  resolvedAt: null,
  firstSeenRunId: "run-1",
  lastSeenRunId: "run-1",
  createdAt: "2026-10-28T02:01:00.000Z",
};

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: string;
  readonly authorization: string | null;
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
    authorization: request?.headers.get("authorization") ?? null,
  });
  const method = request?.method ?? "GET";

  if (method === "GET") {
    switch (url.pathname) {
      case "/v1/reconciliation/runs":
        return json(200, { runs: [run] });
      case "/v1/reconciliation/runs/run-1":
        return json(200, { run });
      case "/v1/reconciliation/exceptions":
        return json(200, { exceptions: [exception] });
      case "/v1/tenants/current/config":
        return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
      default:
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
    }
  }

  switch (url.pathname) {
    case "/v1/reconciliation/runs/run-1/sign-off":
      return json(200, {
        run: {
          ...run,
          status: "signed_off",
          signedOffByUserId: "finance-1",
          signedOffAt: "2026-10-29T09:00:00.000Z",
          signOffNote: bodyNote(),
        },
      });
    case "/v1/reconciliation/exceptions/ex-1/resolve":
      return json(200, { exception: { ...exception, status: "resolved" } });
    case "/v1/reconciliation/exceptions/ex-1/waive":
      return json(200, { exception: { ...exception, status: "waived" } });
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
});

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function bodyNote(): string {
  const body = requests.at(-1)?.body ?? "{}";
  const parsed = JSON.parse(body) as { note?: string };
  return parsed.note ?? "";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FINANCE = ["reconciliation:read", "reconciliation:run"];
const AUDITOR = ["reconciliation:read"];

function renderPage(permissions: readonly string[] = FINANCE): void {
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
      <ReconciliationPage />
    </QueryClientProvider>,
  );
}

function bodyOf(path: string, method: string): Record<string, unknown> | undefined {
  const found = requests.filter((row) => row.path === path && row.method === method).at(-1);
  return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>);
}

async function openRun(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  expect(await screen.findByText("Debits equal credits for the day")).toBeTruthy();
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

describe("ReconciliationPage", () => {
  it("lists the runs in range and shows the selected run's checklist", async () => {
    renderPage();

    // The tenant fixture renders business days as dd/MM/yyyy.
    expect(await screen.findByText("28/10/2026")).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();

    await openRun();

    expect(screen.getByText("Every statement row is matched to a payment")).toBeTruthy();
    expect(screen.getAllByText("Within tolerance")).toHaveLength(2);
    // The detail request is the run, not a client-side re-derivation.
    expect(requests.some((row) => row.path === "/v1/reconciliation/runs/run-1")).toBe(true);
    // The queue opens on open items only.
    expect(requests.find((row) => row.path === "/v1/reconciliation/exceptions")?.search).toContain(
      "status=open",
    );
  });

  it("requires a note, then signs the run off with exactly { note }", async () => {
    renderPage();
    await openRun();

    fireEvent.click(screen.getByText("Sign off run"));
    expect(bodyOf("/v1/reconciliation/runs/run-1/sign-off", "POST")).toBeUndefined();

    fireEvent.input(screen.getByPlaceholderText("Sign-off note"), {
      target: { value: "Month closed after clearing the queue" },
    });
    fireEvent.click(screen.getByText("Sign off run"));

    await waitFor(() => {
      expect(bodyOf("/v1/reconciliation/runs/run-1/sign-off", "POST")).toEqual({
        note: "Month closed after clearing the queue",
      });
    });
  });

  it("resolves an exception with exactly { note }", async () => {
    renderPage();
    expect(await screen.findByText("Provider mock")).toBeTruthy();

    fireEvent.click(screen.getByText("Resolve"));
    expect(bodyOf("/v1/reconciliation/exceptions/ex-1/resolve", "POST")).toBeUndefined();

    fireEvent.input(screen.getByPlaceholderText("Resolution note"), {
      target: { value: "Fee difference matched by hand" },
    });
    fireEvent.click(screen.getByText("Resolve"));

    await waitFor(() => {
      expect(bodyOf("/v1/reconciliation/exceptions/ex-1/resolve", "POST")).toEqual({
        note: "Fee difference matched by hand",
      });
    });
  });

  it("waives an exception with exactly { note }", async () => {
    renderPage();
    expect(await screen.findByText("Provider mock")).toBeTruthy();

    fireEvent.input(screen.getByPlaceholderText("Resolution note"), {
      target: { value: "Bank confirmed the shortfall" },
    });
    fireEvent.click(screen.getByText("Waive"));

    await waitFor(() => {
      expect(bodyOf("/v1/reconciliation/exceptions/ex-1/waive", "POST")).toEqual({
        note: "Bank confirmed the shortfall",
      });
    });
  });

  it("gives an auditor the data but no sign-off, resolve or waive controls", async () => {
    renderPage(AUDITOR);

    expect(await screen.findByText("Provider mock")).toBeTruthy();
    expect(screen.getByText(/Read-only view/)).toBeTruthy();

    await openRun();

    expect(screen.queryByText("Sign off run")).toBeNull();
    expect(screen.queryByPlaceholderText("Sign-off note")).toBeNull();
    expect(screen.queryByText("Resolve")).toBeNull();
    expect(screen.queryByText("Waive")).toBeNull();
    expect(requests.filter((row) => row.method === "POST")).toHaveLength(0);
  });

  it("hides the screen entirely without reconciliation:read", async () => {
    renderPage([]);

    expect(
      await screen.findByText("You do not have permission to view reconciliation."),
    ).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/reconciliation"))).toBe(false);
  });
});
