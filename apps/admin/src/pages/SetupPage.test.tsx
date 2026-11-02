import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { App } from "../App.js";
import { SetupPage } from "./SetupPage.js";

/**
 * The setup shell and the App branch that shows it. Part 1 of Step 6: an empty
 * deployment routes to onboarding before it ever shows a sign-in form, and the
 * wizard renders outside `Layout` (no tenant branding or nav exists yet).
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resetStore(): void {
  useSession.setState({
    status: "unknown",
    accessToken: undefined,
    user: undefined,
    initializing: false,
    needsSetup: undefined,
  });
}

beforeAll(() => {
  stubRelativeRequests();
});

afterEach(() => {
  cleanup();
  resetStore();
  vi.unstubAllGlobals();
});

function renderApp(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("SetupPage shell", () => {
  it("lists the four steps a new state walks through", () => {
    render(<SetupPage />);
    expect(screen.getByText("Welcome to your revenue platform")).toBeTruthy();
    for (const label of ["State", "Levy", "Review", "Sign in"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("renders without the tenant Layout", () => {
    render(<SetupPage />);
    // Layout marks its navigation "Primary"; the wizard has no tenant to
    // navigate yet, so none of it may be present.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });
});

describe("first-run detection in App", () => {
  it("shows the wizard instead of sign-in when onboarding is needed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const request = input as Request;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/v1/auth/refresh") {
          return json(401, { error: { code: "unauthorized", message: "no session", requestId: "r" } });
        }
        if (url.pathname === "/v1/setup/status") {
          return json(200, { needsSetup: true });
        }
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );

    renderApp();

    expect(await screen.findByText("Welcome to your revenue platform")).toBeTruthy();
    expect(screen.queryByText("Staff sign-in")).toBeNull();
  });

  it("keeps the sign-in screen when the deployment is already configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const request = input as Request;
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/v1/auth/refresh") {
          return json(401, { error: { code: "unauthorized", message: "no session", requestId: "r" } });
        }
        if (url.pathname === "/v1/setup/status") {
          return json(200, { needsSetup: false });
        }
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );

    renderApp();

    expect(await screen.findByText("Staff sign-in")).toBeTruthy();
    expect(screen.queryByText("Welcome to your revenue platform")).toBeNull();
  });
});
