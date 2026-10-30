import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSession } from "./session.js";
import { stubRelativeRequests } from "./test-support/browserStubs.js";
import { App } from "./App.js";

/**
 * The shell boots into the login screen when the refresh cookie is absent.
 * This renders the real App (and therefore LoginPage and its store wiring):
 * a selector that returns a fresh closure would loop here instead of showing
 * the form, which is exactly the blank-page failure this guards.
 */

const fakeFetch = vi.fn(async (input: unknown): Promise<Response> => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/v1/auth/refresh") {
    return json(401, {
      error: { code: "unauthorized", message: "no session", requestId: "req-1" },
    });
  }
  return json(404, { error: { code: "not_found", message: "nope", requestId: "req-1" } });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  cleanup();
  useSession.setState({ status: "unknown", accessToken: undefined, user: undefined });
  fakeFetch.mockClear();
});

describe("App shell", () => {
  it("boots to the staff sign-in form when there is no session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Staff sign-in")).toBeTruthy();
    expect(screen.getByLabelText("Tenant slug")).toBeTruthy();
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });
});
