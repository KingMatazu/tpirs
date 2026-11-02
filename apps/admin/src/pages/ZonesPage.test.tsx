import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { ZonesPage, zoneRows, type ZoneView } from "./ZonesPage.js";

/**
 * Zone management (11.0b). The screen must work with zero zones (an empty list
 * is a valid tenant), create with and without a parent, and rename in place.
 * Ordering is asserted through `zoneRows`, which is pure.
 */

const requests: { method: string; path: string; body: string }[] = [];

let zones: ZoneView[] = [];

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  requests.push({
    method: request.method,
    path: url.pathname,
    body: request === undefined ? "" : await request.clone().text(),
  });

  if (request.method === "GET" && url.pathname === "/v1/zones") {
    return json(200, { zones });
  }
  if (request.method === "POST" && url.pathname === "/v1/zones") {
    const body = JSON.parse(requests.at(-1)?.body ?? "{}") as {
      name: string;
      parentZoneId?: string;
    };
    const zone: ZoneView = {
      id: `z${String(zones.length + 1)}`,
      parentZoneId: body.parentZoneId ?? null,
      name: body.name,
    };
    zones = [...zones, zone];
    return json(201, { zone });
  }
  const renameMatch = /^\/v1\/zones\/(.+)$/.exec(url.pathname);
  if (request.method === "PATCH" && renameMatch !== null) {
    const id = renameMatch[1];
    const body = JSON.parse(requests.at(-1)?.body ?? "{}") as { name: string };
    const existing = zones.find((zone) => zone.id === id);
    if (existing === undefined) {
      return json(404, { error: { code: "not_found", message: "Zone not found", requestId: "r1" } });
    }
    const updated: ZoneView = { ...existing, name: body.name };
    zones = zones.map((zone) => (zone.id === id ? updated : zone));
    return json(200, { zone: updated });
  }
  return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MANAGER = ["zone:read", "zone:manage"];
const READER = ["zone:read"];

/** The list is the only `ul`; scoping avoids the parent `<option>` duplicating a name. */
function zoneList(): HTMLElement {
  return screen.getByRole("list");
}

function renderPage(permissions: readonly string[] = MANAGER): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["zone_supervisor"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ZonesPage />
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
  cleanup();
  useSession.setState({ status: "unknown", accessToken: undefined, user: undefined });
  fakeFetch.mockClear();
  requests.length = 0;
  zones = [];
});

describe("zoneRows", () => {
  const top = { id: "a", parentZoneId: null, name: "Beta" };
  const top2 = { id: "b", parentZoneId: null, name: "Alpha" };
  const child = { id: "c", parentZoneId: "a", name: "Child" };
  const orphan = { id: "d", parentZoneId: "missing", name: "Orphan" };

  it("orders parents alphabetically with children nested under them", () => {
    expect(zoneRows([top, top2, child]).map((row) => [row.zone.id, row.depth])).toEqual([
      ["b", 0],
      ["a", 0],
      ["c", 1],
    ]);
  });

  it("still shows a zone whose parent is not in the list", () => {
    const rows = zoneRows([orphan]);
    expect(rows.map((row) => row.zone.id)).toEqual(["d"]);
  });
});

describe("ZonesPage", () => {
  it("treats an empty list as valid and explains it", async () => {
    renderPage();
    expect(await screen.findByText(/No zones yet/)).toBeTruthy();
    expect(screen.getByText(/Leaving this list\s+empty is valid/)).toBeTruthy();
  });

  it("creates a top-level zone and refreshes the list", async () => {
    renderPage();
    await screen.findByText(/No zones yet/);

    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Central" } });
    fireEvent.click(screen.getByRole("button", { name: "Add zone" }));

    expect(await screen.findByText("Central", { selector: "span.text-slate-900" })).toBeTruthy();
    const post = requests.find((row) => row.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ name: "Central" });
  });

  it("creates a child zone inside the selected parent", async () => {
    zones = [{ id: "p1", parentZoneId: null, name: "Central" }];
    renderPage();

    await waitFor(() => {
      expect(within(zoneList()).getByText("Central")).toBeTruthy();
    });
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Central Market" } });
    fireEvent.change(screen.getByLabelText("Parent zone"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add zone" }));

    expect(await within(zoneList()).findByText("Central Market")).toBeTruthy();
    const post = requests.find((row) => row.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "Central Market",
      parentZoneId: "p1",
    });
  });

  it("renames a zone in place and sends a PATCH", async () => {
    zones = [{ id: "p1", parentZoneId: null, name: "Central" }];
    renderPage();
    await waitFor(() => {
      expect(within(zoneList()).getByText("Central")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.input(screen.getByLabelText("Rename zone"), {
      target: { value: "Central District" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(within(zoneList()).getByText("Central District")).toBeTruthy();
    });
    const patch = requests.find((row) => row.method === "PATCH");
    expect(patch?.path).toBe("/v1/zones/p1");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "Central District" });
  });

  it("hides the editor from a reader but still lists zones", async () => {
    zones = [{ id: "p1", parentZoneId: null, name: "Central" }];
    renderPage(READER);
    expect(await screen.findByText("Central", { selector: "span.text-slate-900" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add zone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});
