import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { RegistryPage } from "./RegistryPage.js";

/**
 * Registry screen with a stubbed global fetch.
 *
 * The workflow under test is the one an operator performs: find an asset, open
 * it, read the attributes the tenant's schema declares, suspend it with a
 * reason, correct its attributes, download the sticker, and verify the owner's
 * phone. Every request body is asserted: these are audited changes, and the
 * client must never send a shape the contract does not describe.
 *
 * The negative case matters as much as the happy path: an auditor holds
 * `asset:read` only, so the screen must render the same data with no mutation
 * controls and fire no non-GET request at all.
 */

const config = loadFixtureConfig();

const asset = {
  id: "as_1",
  assetTypeKey: "bike",
  status: "active" as "active" | "suspended" | "retired",
  zoneId: "zone-a",
  ownerId: "ow_1",
  // `colour` is not in the fixture's bike schema: it must still be shown.
  attributes: { plate_number: "AB12345", colour: "red" } as Record<string, unknown>,
  qrToken: "qr_1",
  shortCode: "B123",
};

const owner = {
  id: "ow_1",
  displayName: "Ada Obi",
  phone: "+2348012345678",
  phoneVerifiedAt: null as string | null,
};

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
  // Duck-typed, not `instanceof Request`: the sticker download is a plain
  // `fetch(path, init)` call and vitest may use a Request from another realm.
  const request = typeof input === "string" ? undefined : (input as Request);
  const body = request === undefined ? "" : await request.clone().text();
  requests.push({
    method: request?.method ?? init?.method ?? "GET",
    path: url.pathname,
    search: url.search,
    body,
    authorization: headerValue(request?.headers ?? init?.headers, "authorization"),
  });

  if (request?.method === "PATCH") {
    const parsed = JSON.parse(body) as { attributes: Record<string, unknown> };
    return json(200, { asset: { ...asset, attributes: parsed.attributes } });
  }

  switch (url.pathname) {
    case "/v1/tenants/current/config":
      return json(200, { config: JSON.parse(JSON.stringify(config)), version: 3 });
    case "/v1/assets":
      return json(200, { assets: [asset] });
    case "/v1/assets/as_1":
      return json(200, {
        asset,
        photos: [{ id: "p1", url: "/v1/assets/as_1/photos/p1", contentType: "image/jpeg" }],
      });
    case "/v1/assets/as_1/sticker":
      return new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      });
    case "/v1/owners/ow_1":
      return json(200, { owner });
    case "/v1/assets/as_1/suspend":
      return json(200, { asset: { ...asset, status: "suspended" } });
    case "/v1/owners": {
      const parsed = JSON.parse(body) as { displayName: string; phone: string };
      return json(201, { owner: { ...owner, id: "ow_new", ...parsed } });
    }
    case "/v1/owners/verify/request":
      return json(200, { sent: true });
    case "/v1/owners/verify/confirm":
      return json(200, { owner: { ...owner, phoneVerifiedAt: "2026-10-29T10:00:00.000Z" } });
    default:
      return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
  }
});

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ALL_PERMISSIONS = ["asset:read", "asset:manage"];

function renderPage(permissions: readonly string[] = ALL_PERMISSIONS): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "registrar-1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["system_admin"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RegistryPage />
    </QueryClientProvider>,
  );
}

async function openAsset(permissions: readonly string[] = ALL_PERMISSIONS): Promise<void> {
  renderPage(permissions);
  fireEvent.click(await screen.findByText("Open"));
  expect(await screen.findByText("Plate number")).toBeTruthy();
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
  vi.restoreAllMocks();
});

describe("RegistryPage", () => {
  it("lists assets and sends the free-text search as the query parameter", async () => {
    renderPage();

    expect(await screen.findByText("B123")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Bicycle" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Active" })).toBeTruthy();
    expect(screen.getByText("zone-a")).toBeTruthy();
    // The unfiltered list sends the page size only.
    const first = requests.find((row) => row.path === "/v1/assets");
    expect(new URLSearchParams(first?.search ?? "").get("query")).toBeNull();

    fireEvent.input(screen.getByLabelText("Search"), { target: { value: "AB12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      const last = requests.filter((row) => row.path === "/v1/assets").at(-1);
      expect(new URLSearchParams(last?.search ?? "").get("query")).toBe("AB12345");
    });
  });

  it("renders the detail from the configured schema, extras included", async () => {
    await openAsset();

    expect(screen.getByText("Plate number")).toBeTruthy();
    expect(screen.getByText("AB12345")).toBeTruthy();
    // An attribute the tenant's schema does not declare is listed, not dropped.
    expect(screen.getByText("colour")).toBeTruthy();
    expect(screen.getByText("red")).toBeTruthy();
    expect(screen.getByText("not in schema")).toBeTruthy();
  });

  it("suspends with the reason on the asset's own path", async () => {
    await openAsset();

    fireEvent.click(screen.getByText("Suspend asset"));
    // A blank reason is refused before it reaches the API.
    expect(bodyOf("/v1/assets/as_1/suspend", "POST")).toBeUndefined();

    fireEvent.input(screen.getByLabelText("Reason"), { target: { value: "Sticker swapped" } });
    fireEvent.click(screen.getByText("Suspend asset"));

    await waitFor(() => {
      expect(bodyOf("/v1/assets/as_1/suspend", "POST")).toEqual({ reason: "Sticker swapped" });
    });
  });

  it("patches the whole attribute set from the JSON editor", async () => {
    await openAsset();

    const editor = screen.getByLabelText("Attributes JSON") as HTMLTextAreaElement;
    expect(editor.value).toContain('"plate_number"');

    fireEvent.change(editor, {
      target: { value: JSON.stringify({ plate_number: "ZZ99999" }) },
    });
    fireEvent.click(screen.getByText("Save correction"));

    await waitFor(() => {
      expect(bodyOf("/v1/assets/as_1", "PATCH")).toEqual({
        attributes: { plate_number: "ZZ99999" },
      });
    });
  });

  it("refuses malformed JSON without calling the API", async () => {
    await openAsset();

    fireEvent.change(screen.getByLabelText("Attributes JSON"), { target: { value: "{" } });
    fireEvent.click(screen.getByText("Save correction"));

    // The parse happens before any request; nothing reaches the API.
    await waitFor(() => {
      expect(requests.some((row) => row.method === "PATCH")).toBe(false);
    });
  });

  it("downloads the sticker with the bearer and a derived filename", async () => {
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });

    await openAsset();
    fireEvent.click(screen.getByText("Download sticker"));

    await waitFor(() => {
      expect(downloads).toEqual(["sticker-B123.svg"]);
    });
    const request = requests.find((row) => row.path === "/v1/assets/as_1/sticker");
    expect(request?.method).toBe("GET");
    expect(request?.authorization).toBe("Bearer tok");
  });

  it("looks up an owner and confirms a verification code", async () => {
    await openAsset();

    fireEvent.click(screen.getByText("Look up owner"));
    expect(await screen.findByText("Ada Obi")).toBeTruthy();
    expect(screen.getByText(/^Not verified/)).toBeTruthy();

    fireEvent.click(screen.getByText("Send verification code"));
    await waitFor(() => {
      expect(bodyOf("/v1/owners/verify/request", "POST")).toEqual({ ownerId: "ow_1" });
    });

    fireEvent.input(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByText("Confirm code"));

    await waitFor(() => {
      expect(bodyOf("/v1/owners/verify/confirm", "POST")).toEqual({
        ownerId: "ow_1",
        code: "123456",
      });
    });
    expect(await screen.findByText(/^Verified/)).toBeTruthy();
  });

  it("creates an owner and selects it for verification", async () => {
    await openAsset();

    fireEvent.input(screen.getByLabelText("Owner name"), { target: { value: "  Ada  " } });
    fireEvent.input(screen.getByLabelText("Owner phone"), {
      target: { value: " +2348012345678 " },
    });
    fireEvent.click(screen.getByText("Create owner"));

    await waitFor(() => {
      expect(bodyOf("/v1/owners", "POST")).toEqual({
        displayName: "Ada",
        phone: "+2348012345678",
      });
    });
    await waitFor(() => {
      expect(input("ownerId")?.value).toBe("ow_new");
    });
  });

  it("shows the data but no mutation controls to a read-only role", async () => {
    await openAsset(["asset:read"]);

    expect(screen.getByText("AB12345")).toBeTruthy();
    expect(screen.getByText(/^Read-only/)).toBeTruthy();
    expect(screen.queryByText("Suspend asset")).toBeNull();
    expect(screen.queryByText("Save correction")).toBeNull();
    expect(screen.queryByText("Create owner")).toBeNull();
    expect(screen.queryByLabelText("Attributes JSON")).toBeNull();
    // The screen only ever reads; a hidden control must not fire either.
    expect(requests.some((row) => row.method !== "GET")).toBe(false);
  });

  it("hides the screen entirely without asset:read", async () => {
    renderPage([]);

    expect(
      await screen.findByText("You do not have permission to view the registry."),
    ).toBeTruthy();
    expect(requests.some((row) => row.path.startsWith("/v1/assets"))).toBe(false);
  });
});
