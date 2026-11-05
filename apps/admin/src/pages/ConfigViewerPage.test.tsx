import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { useSession } from "../session.js";
import { ConfigViewerPage } from "./ConfigViewerPage.js";

/**
 * The configuration page: a system admin gets an editable identity card above
 * the read-only sections; everyone else with `tenant:read` sees the same page
 * without a way to change it.
 */

const fixture = loadFixtureConfig();

const fakeFetch = vi.fn(async (input: unknown) => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/v1/tenants/current/config") {
    return new Response(JSON.stringify({ config: fixture, version: 3 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
});

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  fakeFetch.mockClear();
  useSession.setState({ status: "unknown", accessToken: undefined, user: undefined });
});

function renderPage(permissions: readonly string[]): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["system_admin"],
      permissions: [...permissions],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ConfigViewerPage />
    </QueryClientProvider>,
  );
}

describe("ConfigViewerPage", () => {
  it("gives a system admin the editable identity card", async () => {
    renderPage(["tenant:read", "tenant:configure"]);
    await waitFor(() => {
      expect(screen.getByText("State identity and branding")).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Save state details" })).toBeDefined();
    // The read-only sections are still there, below the card.
    expect(screen.getByText("Tenant configuration")).toBeDefined();
    expect(screen.getByText("Asset types")).toBeDefined();
  });

  it("shows an auditor the same config with no way to change it", async () => {
    renderPage(["tenant:read"]);
    await waitFor(() => {
      expect(screen.getByText("Tenant configuration")).toBeDefined();
    });
    expect(screen.queryByText("State identity and branding")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save state details" })).toBeNull();
  });

  it("renders the logo as a description, never as a wall of base64", async () => {
    renderPage(["tenant:read"]);
    await waitFor(() => {
      expect(screen.getByText("Branding")).toBeDefined();
    });
    expect(screen.getByText("https://cdn.example.state.gov/logo.svg")).toBeDefined();
  });
});
