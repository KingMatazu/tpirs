import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatMoneyMinor } from "@tpirs/ui-tokens";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { ReportsPage } from "./ReportsPage.js";

/**
 * Reports screen with a stubbed global fetch.
 *
 * The table is server-described: the route returns columns with a `kind`, and
 * the page must format a minor-unit money string as currency while leaving a
 * count as digits. Switching the picker must re-request that report, and the
 * download must hit the export path with the chosen format and save the file
 * under the `content-disposition` name — or the deterministic fallback when a
 * proxy drops the header.
 */

const config = loadFixtureConfig();
const money = formatMoneyMinor("20000", "NGN", "en-NG");

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: string;
  readonly authorization: string | null;
}

const requests: RecordedRequest[] = [];

const fakeFetch = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = new URL(urlOf(input), "http://localhost");
  // Duck-typed, not `instanceof Request`: the export is a plain `fetch(url,
  // init)` call and vitest may use a Request from another realm for the rest.
  const request = typeof input === "string" ? undefined : (input as Request);
  requests.push({
    method: request?.method ?? init?.method ?? "GET",
    path: url.pathname,
    search: url.search,
    body: request === undefined ? "" : await request.clone().text(),
    authorization: headerValue(request?.headers ?? init?.headers, "authorization"),
  });

  switch (url.pathname) {
    case "/v1/tenants/current/config":
      return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
    case "/v1/reports/daily_collections":
      return json(200, {
        report: {
          reportKey: "daily_collections",
          from: url.searchParams.get("from") ?? "",
          to: url.searchParams.get("to") ?? "",
          generatedAt: "2026-10-29T09:00:00.000Z",
          columns: [
            { key: "businessDate", header: "Business day", kind: "text" },
            { key: "revenueMinor", header: "Revenue", kind: "money" },
            { key: "paymentsCount", header: "Payments", kind: "count" },
          ],
          rows: [{ businessDate: "2026-10-27", revenueMinor: "20000", paymentsCount: 2 }],
          totals: { revenueMinor: "20000" },
        },
      });
    case "/v1/reports/collections_by_zone":
      return json(200, {
        report: {
          reportKey: "collections_by_zone",
          from: url.searchParams.get("from") ?? "",
          to: url.searchParams.get("to") ?? "",
          generatedAt: "2026-10-29T09:00:00.000Z",
          columns: [
            { key: "zoneId", header: "Zone", kind: "text" },
            { key: "revenueMinor", header: "Revenue", kind: "money" },
          ],
          rows: [{ zoneId: "zone-a", revenueMinor: "40000" }],
          totals: { revenueMinor: "40000" },
        },
      });
    case "/v1/reports/daily_collections/export": {
      const format = url.searchParams.get("format");
      const headers: Record<string, string> =
        format === "csv"
          ? {
              "content-type": "text/csv",
              "content-disposition":
                'attachment; filename="daily_collections-2026-06-15-2026-06-16.csv"',
            }
          : { "content-type": "application/pdf" };
      return new Response("collected,200\n", { status: 200, headers });
    }
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
});

function headerValue(headers: RequestInit["headers"] | undefined, name: string): string | null {
  if (headers === undefined) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name);
    return found === undefined ? null : found[1];
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

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

function renderPage(permissions: readonly string[] = ["report:read"]): void {
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
      <ReportsPage />
    </QueryClientProvider>,
  );
}

function exportRequest(key: string, format: string): RecordedRequest | undefined {
  return requests.find(
    (row) => row.path === `/v1/reports/${key}/export` && row.search.includes(`format=${format}`),
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
  vi.restoreAllMocks();
});

describe("ReportsPage", () => {
  it("renders the report table with money formatted and counts as digits", async () => {
    renderPage();

    expect(await screen.findByText("Business day")).toBeTruthy();
    expect(screen.getByText("2026-10-27")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    // Once in the row, once in the totals row.
    expect(screen.getAllByText(money)).toHaveLength(2);
    expect(screen.getByText("Total")).toBeTruthy();
    // The range the page opened on is the explicit query it sent.
    const request = requests.find((row) => row.path === "/v1/reports/daily_collections");
    expect(request?.search).toContain("from=");
    expect(request?.search).toContain("to=");
  });

  it("refetches when the report picker changes", async () => {
    renderPage();
    expect(await screen.findByText("Business day")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Report"), {
      target: { value: "collections_by_zone" },
    });

    expect(await screen.findByText("Zone")).toBeTruthy();
    expect(requests.some((row) => row.path === "/v1/reports/collections_by_zone")).toBe(true);
    expect(screen.queryByText("Business day")).toBeNull();
  });

  it("downloads the chosen format and saves it under the content-disposition name", async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    renderPage();
    expect(await screen.findByText("Business day")).toBeTruthy();

    fireEvent.click(screen.getByText("Download CSV"));

    await waitFor(() => {
      expect(downloads).toEqual(["daily_collections-2026-06-15-2026-06-16.csv"]);
    });
    const request = exportRequest("daily_collections", "csv");
    expect(request?.authorization).toBe("Bearer tok");
    expect(request?.search).toContain("from=");
    expect(request?.search).toContain("to=");
  });

  it("falls back to a deterministic filename when content-disposition is absent", async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    renderPage();
    expect(await screen.findByText("Business day")).toBeTruthy();

    fireEvent.click(screen.getByText("Download PDF"));

    await waitFor(() => {
      expect(downloads).toHaveLength(1);
    });
    const request = exportRequest("daily_collections", "pdf");
    const params = new URLSearchParams(request?.search ?? "");
    expect(downloads[0]).toBe(
      `daily_collections-${params.get("from") ?? ""}-${params.get("to") ?? ""}.pdf`,
    );
  });

  it("hides the screen entirely without report:read", async () => {
    renderPage([]);

    expect(await screen.findByText("You do not have permission to view reports.")).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/reports"))).toBe(false);
  });
});
