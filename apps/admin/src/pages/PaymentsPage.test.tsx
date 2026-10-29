import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import type { OutboxMessageView, PaymentView } from "../lib/paymentsView.js";
import { PaymentsPage } from "./PaymentsPage.js";

/**
 * Payments and suspense screen with a stubbed global fetch.
 *
 * The workflow under test is the one finance performs: read the day's payments
 * with their attribution and receipt, open the receipt outbox, then resolve a
 * suspense payment by asset id. The resolve body is asserted exactly — the
 * contract has one field and the server re-validates it.
 *
 * The auditor case is the other half of the acceptance check: both lists and
 * the outbox stay visible, the resolve control is absent, and no POST ever
 * leaves the browser. A role without `payment:read` gets the permission message
 * and no payment request at all.
 */

const config = loadFixtureConfig();
const money = formatMoneyMinor("20000", "NGN", "en-NG");
const suspenseMoney = formatMoneyMinor("15000", "NGN", "en-NG");

const payment: PaymentView = {
  id: "pay-1",
  status: "credited",
  amountMinor: "20000",
  currency: "NGN",
  provider: "mock",
  providerReference: "MOCK-PAY-1",
  assetId: "as_1",
  attributionKind: "asset",
  businessDate: "2026-10-28",
  receiptNumber: "RCPT-1",
  failureReason: null,
  createdAt: "2026-10-28T09:00:00.000Z",
};

const suspensePayment: PaymentView = {
  ...payment,
  id: "pay-2",
  status: "suspense",
  amountMinor: "15000",
  providerReference: "MOCK-PAY-2",
  assetId: null,
  receiptNumber: null,
  createdAt: "2026-10-28T10:00:00.000Z",
};

const outboxMessages: readonly OutboxMessageView[] = [
  {
    id: "m1",
    kind: "receipt",
    recipient: "+2348000000000",
    body: "Your receipt RCPT-1 is ready.",
    status: "sent",
    createdAt: "2026-10-28T09:01:00.000Z",
  },
  {
    id: "m2",
    kind: "receipt",
    recipient: "+2348000000000",
    body: "Your receipt RCPT-1 is ready.",
    status: "pending",
    createdAt: "2026-10-28T09:01:00.000Z",
  },
];

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
  const method = request?.method ?? "GET";
  requests.push({
    method,
    path: url.pathname,
    search: url.search,
    body: request === undefined ? "" : await request.clone().text(),
  });

  if (method === "GET") {
    switch (url.pathname) {
      case "/v1/payments": {
        const status = url.searchParams.get("status");
        const rows =
          status === null
            ? [payment, suspensePayment]
            : [payment, suspensePayment].filter((row) => row.status === status);
        return json(200, { payments: rows });
      }
      case "/v1/payments/suspense":
        return json(200, { payments: [suspensePayment] });
      case "/v1/payments/pay-1/outbox":
        return json(200, { messages: outboxMessages });
      case "/v1/payments/pay-2/outbox":
        return json(200, { messages: [] });
      case "/v1/tenants/current/config":
        return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
      default:
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
    }
  }

  switch (url.pathname) {
    case "/v1/payments/pay-2/resolve": {
      const body = bodyOfLast();
      return json(200, {
        payment: {
          ...suspensePayment,
          status: "credited",
          assetId: body["assetId"],
          receiptNumber: "RCPT-2",
        },
      });
    }
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
});

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function bodyOfLast(): Record<string, unknown> {
  const body = requests.at(-1)?.body ?? "{}";
  return JSON.parse(body) as Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FINANCE = ["payment:read", "payment:manage"];
const AUDITOR = ["payment:read"];

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
      <PaymentsPage />
    </QueryClientProvider>,
  );
}

function bodyOf(path: string, method: string): Record<string, unknown> | undefined {
  const found = requests.filter((row) => row.path === path && row.method === method).at(-1);
  return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>);
}

function tableAt(index: number): HTMLElement {
  const table = screen.getAllByRole("table")[index];
  if (table === undefined) throw new Error(`no table at index ${String(index)}`);
  return table;
}

function firstButton(name: string): HTMLElement {
  const button = screen.getAllByRole("button", { name })[0];
  if (button === undefined) throw new Error(`no button named ${name}`);
  return button;
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

describe("PaymentsPage", () => {
  it("lists payments with amount, status, asset and receipt", async () => {
    renderPage();

    expect(await screen.findByText("MOCK-PAY-1")).toBeTruthy();
    const payments = within(tableAt(0));
    expect(payments.getByText("Credited")).toBeTruthy();
    expect(payments.getByText(money)).toBeTruthy();
    expect(payments.getByText("RCPT-1")).toBeTruthy();
    expect(payments.getByText("as_1")).toBeTruthy();
    // The fixture renders business days as dd/MM/yyyy.
    expect(payments.getAllByText("28/10/2026")).toHaveLength(2);
    expect(requests.some((row) => row.path === "/v1/payments")).toBe(true);
  });

  it("sends the status filter and narrows the list", async () => {
    renderPage();
    expect(await screen.findByText("MOCK-PAY-1")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "suspense" } });

    await waitFor(() => {
      expect(
        requests.some(
          (row) => row.path === "/v1/payments" && row.search.includes("status=suspense"),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("MOCK-PAY-1")).toBeNull();
    });
    expect(screen.getAllByText("MOCK-PAY-2").length).toBeGreaterThan(0);
  });

  it("shows the suspense queue with a confirmation naming the amount and reference", async () => {
    renderPage();

    expect((await screen.findAllByText("MOCK-PAY-2")).length).toBeGreaterThan(0);
    expect(requests.some((row) => row.path === "/v1/payments/suspense")).toBe(true);
    expect(screen.getAllByText(suspenseMoney).length).toBeGreaterThan(0);
    expect(
      screen.getByText(new RegExp(`Assign .*${suspenseMoney}.*MOCK-PAY-2.*asset id above`, "u")),
    ).toBeTruthy();
  });

  it("loads the receipt outbox for the selected payment", async () => {
    renderPage();
    expect(await screen.findByText("MOCK-PAY-1")).toBeTruthy();

    fireEvent.click(firstButton("Receipt status"));

    expect(await screen.findByText("Receipt messages · MOCK-PAY-1")).toBeTruthy();
    expect((await screen.findAllByText("Your receipt RCPT-1 is ready.")).length).toBe(2);
    expect(requests.some((row) => row.path === "/v1/payments/pay-1/outbox")).toBe(true);

    const outbox = within(tableAt(1));
    expect(outbox.getByText("Sent")).toBeTruthy();
    expect(outbox.getByText("Pending")).toBeTruthy();
  });

  it("resolves a suspense payment with exactly { assetId }", async () => {
    renderPage();

    const assetId = await screen.findByPlaceholderText("Asset id");
    fireEvent.input(assetId, { target: { value: "  as_9 " } });
    fireEvent.click(firstButton("Resolve payment"));

    await waitFor(() => {
      expect(bodyOf("/v1/payments/pay-2/resolve", "POST")).toEqual({ assetId: "as_9" });
    });
  });

  it("hides resolve without payment:manage but keeps both lists and the outbox", async () => {
    renderPage(AUDITOR);
    expect(await screen.findByText("MOCK-PAY-1")).toBeTruthy();
    expect((await screen.findAllByText("MOCK-PAY-2")).length).toBeGreaterThan(0);

    expect(screen.queryByRole("button", { name: "Resolve payment" })).toBeNull();
    expect(
      screen.getByText(/Read-only view: resolving a suspense payment needs the payment:manage/),
    ).toBeTruthy();

    fireEvent.click(firstButton("Receipt status"));
    expect((await screen.findAllByText("Your receipt RCPT-1 is ready.")).length).toBe(2);

    // The audit case: not a single mutation leaves the browser.
    expect(requests.every((row) => row.method === "GET")).toBe(true);
  });

  it("shows the permission message and sends no payment request without payment:read", async () => {
    renderPage([]);

    expect(await screen.findByText("You do not have permission to view payments.")).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/payments"))).toBe(false);
  });
});
