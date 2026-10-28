import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { CollectorsPage } from "./CollectorsPage.js";

/**
 * Collector cash screen with a stubbed global fetch.
 *
 * The workflow under test is the one a supervisor performs: open a wallet, take
 * cash for a driver (the amount pre-fills from the fee rule, the client
 * reference is minted in the browser), freeze the wallet with a reason, and
 * match a suspense deposit to an open intake. Every request body is asserted:
 * these carry money, and the server re-validates them, but the client must
 * never send a shape the contract does not describe.
 */

const fixture = loadFixtureConfig();
/**
 * The fixture's fee rule starts in 2026; the form only pre-fills a rule that is
 * already effective, so the test back-dates it instead of moving the clock.
 */
const config: typeof fixture = {
  ...fixture,
  obligations: {
    ...fixture.obligations,
    feeRules: fixture.obligations.feeRules.map((rule) => ({ ...rule, effectiveFrom: "2020-01-01" })),
  },
};
const money = formatMoneyMinor("20000", "NGN", "en-NG");

const wallet = {
  collectorUserId: "collector-1",
  status: "active" as "active" | "frozen",
  frozenAt: null as string | null,
  frozenReason: null as string | null,
  overdueSince: null as string | null,
  floatCeilingMinor: "5000000" as string | null,
  balanceMinor: "20000",
  openIntakeTotalMinor: "20000",
  oldestOpenIntakeAt: "2026-10-27T09:00:00.000Z" as string | null,
  lastDepositAt: null as string | null,
};

const intake = {
  id: "ci1",
  collectorUserId: "collector-1",
  assetId: "as_1",
  zoneId: null,
  businessDate: "2026-10-27",
  amountMinor: "20000",
  currency: "NGN",
  status: "open",
  receiptNumber: "RCPT-1",
  recordedAt: "2026-10-27T09:00:00.000Z",
};

const deposit = {
  id: "cd1",
  provider: "mock",
  providerReference: "MOCK-DEP-1",
  collectorUserId: "collector-1",
  amountMinor: "20000",
  currency: "NGN",
  status: "suspense",
  createdAt: "2026-10-27T18:00:00.000Z",
};

const assets = [
  {
    id: "as_1",
    assetTypeKey: "bike",
    shortCode: "B123",
    attributes: { plate_number: "AB-123" },
  },
];

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const requests: RecordedRequest[] = [];
/** Server-side state: a freeze changes what the next wallet read returns. */
let walletFrozen = false;

function currentWallet(): typeof wallet {
  return walletFrozen
    ? {
        ...wallet,
        status: "frozen",
        frozenAt: "2026-10-28T10:00:00.000Z",
        frozenReason: "Float not deposited",
      }
    : { ...wallet };
}

const fakeFetch = vi.fn(async (input: unknown): Promise<Response> => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  requests.push({ method: request.method, path: url.pathname, body: await request.clone().text() });

  if (request.method === "GET") {
    switch (url.pathname) {
      case "/v1/cash/wallets":
        return json(200, { wallets: [currentWallet()] });
      case "/v1/cash/wallets/collector-1":
        return json(200, { wallet: currentWallet(), intakes: [intake], nextCursor: null });
      case "/v1/cash/deposits":
        return json(200, { deposits: [deposit], nextCursor: null, hasMore: false });
      case "/v1/assets":
        return json(200, { assets, nextCursor: null });
      case "/v1/tenants/current/config":
        return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
      default:
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
    }
  }

  switch (url.pathname) {
    case "/v1/cash/intakes":
      return json(200, {
        intakeId: "ci2",
        collectorUserId: "collector-1",
        assetId: "as_1",
        assetRef: "B123",
        receiptNumber: "RCPT-2",
        businessDate: "2026-10-28",
        balanceMinor: "40000",
        smsQueued: true,
        replayed: false,
      });
    case "/v1/cash/wallets/collector-1/freeze":
      walletFrozen = true;
      return json(200, { wallet: currentWallet() });
    case "/v1/cash/wallets/collector-1/unfreeze":
      walletFrozen = false;
      return json(200, { wallet: currentWallet() });
    case "/v1/cash/deposits/cd1/match":
      return json(200, {
        depositId: "cd1",
        outcome: "matched",
        collectorUserId: "collector-1",
        allocatedMinor: "20000",
        currency: "NGN",
        replayed: false,
      });
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

const ALL_PERMISSIONS = [
  "cash:read",
  "cash:intake",
  "cash:freeze",
  "cash:unfreeze",
  "cash:deposit:read",
  "cash:deposit:match",
];

function renderPage(permissions: readonly string[] = ALL_PERMISSIONS): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "supervisor-1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["zone_supervisor"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CollectorsPage />
    </QueryClientProvider>,
  );
}

async function openWallet(permissions: readonly string[] = ALL_PERMISSIONS): Promise<void> {
  renderPage(permissions);
  fireEvent.click(await screen.findByText("Open"));
  expect(await screen.findByText("RCPT-1")).toBeTruthy();
}

function bodyOf(path: string, method: string): Record<string, unknown> | undefined {
  const found = requests.filter((row) => row.path === path && row.method === method).at(-1);
  return found === undefined ? undefined : (JSON.parse(found.body) as Record<string, unknown>);
}

function input(name: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
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
  walletFrozen = false;
});

describe("CollectorsPage", () => {
  it("lists wallets with the derived float and the oldest open intake", async () => {
    renderPage();
    expect(await screen.findByText("collector-1")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // The float held and the open-intake total are the same amount today.
    expect(screen.getAllByText(money)).toHaveLength(2);
    expect(screen.getByText(/^\d+ h$/)).toBeTruthy();
  });

  it("hides the screen entirely without cash:read", async () => {
    renderPage([]);
    expect(
      await screen.findByText("You do not have permission to view collector cash."),
    ).toBeTruthy();
    expect(requests.some((row) => row.path === "/v1/cash/wallets")).toBe(false);
  });

  it("pre-fills the fee and sends the browser-minted client reference", async () => {
    await openWallet();

    // The lookup must land before the change handler can resolve the asset type.
    await screen.findByRole("option", { name: /B123/ });
    fireEvent.change(screen.getByLabelText("Asset"), { target: { value: "as_1" } });

    await waitFor(() => {
      expect(input("amountMinor")?.value).toBe("20000");
    });
    const reference = input("clientReference")?.value ?? "";
    expect(reference).toMatch(/^cash-collector-1-/);

    fireEvent.click(screen.getByText("Record cash intake"));

    await waitFor(() => {
      expect(bodyOf("/v1/cash/intakes", "POST")).toBeDefined();
    });
    expect(bodyOf("/v1/cash/intakes", "POST")).toMatchObject({
      collectorUserId: "collector-1",
      assetId: "as_1",
      amountMinor: "20000",
      currency: "NGN",
      clientReference: reference,
    });

    // A spent reference is replaced, so the next driver's cash cannot dedupe
    // against the previous intake.
    await waitFor(() => {
      expect(input("clientReference")?.value).not.toBe(reference);
    });
  });

  it("requires a reason, freezes, then shows the unfreeze as finance-only", async () => {
    await openWallet(["cash:read", "cash:intake", "cash:freeze", "cash:deposit:read"]);

    fireEvent.click(screen.getByText("Freeze wallet"));
    expect(bodyOf("/v1/cash/wallets/collector-1/freeze", "POST")).toBeUndefined();

    fireEvent.input(screen.getByPlaceholderText("Reason to freeze"), {
      target: { value: "Float not deposited" },
    });
    fireEvent.click(screen.getByText("Freeze wallet"));

    await waitFor(() => {
      expect(bodyOf("/v1/cash/wallets/collector-1/freeze", "POST")).toEqual({
        reason: "Float not deposited",
      });
    });

    // The wallet is now frozen; a supervisor cannot undo that.
    const unfreeze = (await screen.findByRole("button", { name: "Unfreeze wallet" })) as HTMLButtonElement;
    expect(unfreeze.disabled).toBe(true);
    expect(screen.getByText("Only finance can unfreeze.")).toBeTruthy();
  });

  it("lets finance unfreeze a frozen wallet with a reason", async () => {
    walletFrozen = true;
    await openWallet();

    fireEvent.input(await screen.findByPlaceholderText("Reason to unfreeze"), {
      target: { value: "Deposit confirmed" },
    });
    fireEvent.click(screen.getByText("Unfreeze wallet"));

    await waitFor(() => {
      expect(bodyOf("/v1/cash/wallets/collector-1/unfreeze", "POST")).toEqual({
        reason: "Deposit confirmed",
      });
    });
  });

  it("matches a suspense deposit to an open intake", async () => {
    await openWallet();

    fireEvent.change(screen.getByLabelText("Suspense deposit"), { target: { value: "cd1" } });
    fireEvent.change(screen.getByLabelText("Open intake"), { target: { value: "ci1" } });
    fireEvent.click(screen.getByText("Match deposit"));

    await waitFor(() => {
      expect(bodyOf("/v1/cash/deposits/cd1/match", "POST")).toEqual({ intakeId: "ci1" });
    });
  });
});
