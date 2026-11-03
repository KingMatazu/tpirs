import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("offers timezone and currency as closed lists instead of free text", () => {
    render(<SetupPage />);
    const timezone = screen.getByLabelText(/Timezone/) as HTMLSelectElement;
    const currency = screen.getByLabelText(/Currency/) as HTMLSelectElement;
    expect(timezone.tagName).toBe("SELECT");
    expect(currency.tagName).toBe("SELECT");
    expect([...timezone.options].some((option) => option.value === "Africa/Lagos")).toBe(true);
    expect([...currency.options].some((option) => option.value === "NGN")).toBe(true);
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
          return json(401, {
            error: { code: "unauthorized", message: "no session", requestId: "r" },
          });
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
          return json(401, {
            error: { code: "unauthorized", message: "no session", requestId: "r" },
          });
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

describe("wizard flow (steps 1–3)", () => {
  let tenantBody: Record<string, unknown> | undefined;

  function isRequestLike(input: unknown): boolean {
    return (
      typeof input === "object" && input !== null && typeof (input as Request).url === "string"
    );
  }

  function installFetch(onTenant?: (body: Record<string, unknown>) => void): void {
    tenantBody = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = isRequestLike(input)
          ? (input as Request)
          : new Request(String(input), init);
        const url = new URL(request.url, "http://localhost").pathname;
        if (url === "/v1/setup/tenant" && request.method === "POST") {
          tenantBody = (await request.json()) as Record<string, unknown>;
          onTenant?.(tenantBody);
          return json(201, { tenantSlug: "katsina-state", temporaryUsername: "admin" });
        }
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );
  }

  function fill(input: (label: string) => HTMLElement, label: string, value: string): void {
    const element = input(label);
    // React listens to `input` for text fields and `change` for a <select>.
    const event = element.tagName === "SELECT" ? fireEvent.change : fireEvent.input;
    event(element, { target: { value } });
  }

  function input(label: string): HTMLElement {
    // The Field component folds its hint into the label's accessible name
    // ("Slug Used in the sign-in form and URLs."), so match by substring.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return screen.getByLabelText(new RegExp(escaped));
  }

  function completeToReview(): void {
    render(<SetupPage />);
    fill(input, "State name", "Katsina State");
    expect(input("Slug")).toHaveProperty("value", "katsina-state");
    fill(input, "Legal entity", "Katsina State Revenue Authority");
    fill(input, "Support email", "support@katsina-state.example.gov");
    fill(input, "Support phone", "+2348000000000");
    fill(input, "Timezone", "Africa/Lagos");
    fill(input, "Currency", "NGN");
    fill(input, "Administrator email", "admin@katsina-state.example.gov");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Daily levy")).toBeTruthy();

    fill(input, "Motorbike (per day)", "300.00");
    fill(input, "Tuk-tuk (per day)", "450.00");
    fill(input, "USSD code", "*347*1#");
    fill(input, "SMS sender id", "KATSINALE");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
  }

  it("derives the slug from the name until it is edited", () => {
    render(<SetupPage />);
    fill(input, "State name", "Katsina State");
    expect(input("Slug")).toHaveProperty("value", "katsina-state");
    fill(input, "Slug", "katsina-state-revenue");
    fill(input, "State name", "Kebbi State");
    // A touched slug is the operator's, not re-derived.
    expect(input("Slug")).toHaveProperty("value", "katsina-state-revenue");
  });

  it("stays on the first step and lists every missing field", () => {
    render(<SetupPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("State name is required")).toBeTruthy();
    expect(screen.getByText("Legal entity is required")).toBeTruthy();
    expect(screen.getByText("Support email must be a valid email address")).toBeTruthy();
    expect(screen.getByText("State details")).toBeTruthy();
  });

  it("converts major-unit levies to minor units and creates the tenant", async () => {
    installFetch();
    completeToReview();
    fireEvent.click(screen.getByRole("button", { name: "Create tenant" }));

    expect(await screen.findByText(/ready/)).toBeTruthy();
    expect(tenantBody).toMatchObject({
      slug: "katsina-state",
      currency: "NGN",
      ussdCode: "*347*1#",
      smsSenderId: "KATSINALE",
      bikeFeeMinor: 30000,
      tuktukFeeMinor: 45000,
      languages: ["en"],
      defaultLanguage: "en",
      adminEmail: "admin@katsina-state.example.gov",
    });
  });

  it("maps server validation issues onto the fields they describe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = isRequestLike(input)
          ? (input as Request)
          : new Request(String(input), init);
        const url = new URL(request.url, "http://localhost").pathname;
        if (url === "/v1/setup/tenant" && request.method === "POST") {
          return json(422, {
            error: {
              code: "unprocessable_entity",
              message: "2 answers need attention",
              requestId: "r",
              issues: [
                { path: "locale.timezone", message: "Timezone must be an IANA zone" },
                { path: "locale.currency", message: "Currency must be an ISO 4217 code" },
              ],
            },
          });
        }
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );
    completeToReview();
    fireEvent.click(screen.getByRole("button", { name: "Create tenant" }));

    // The rejection lands the operator back on the first failing field, with
    // the server's wording inline rather than a bare list on the review.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "State details" })).toBeTruthy();
      expect(screen.getByText("Timezone must be an IANA zone")).toBeTruthy();
      expect(screen.getByText("Currency must be an ISO 4217 code")).toBeTruthy();
    });
  });

  it("hands off to the temporary sign-in after the tenant is created", async () => {
    let loginBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = isRequestLike(input)
          ? (input as Request)
          : new Request(String(input), init);
        const url = new URL(request.url, "http://localhost").pathname;
        if (url === "/v1/setup/tenant" && request.method === "POST") {
          return json(201, { tenantSlug: "katsina-state", temporaryUsername: "admin" });
        }
        if (url === "/v1/auth/login" && request.method === "POST") {
          loginBody = (await request.json()) as Record<string, unknown>;
          return json(200, {
            token: "tok-temp",
            expiresAt: "2026-10-23T13:00:00.000Z",
            user: {
              userId: "u1",
              tenantId: "t1",
              displayName: "Administrator",
              roles: ["system_admin"],
              mustChangeCredentials: true,
            },
            refreshToken: "r-temp",
            refreshExpiresAt: "2026-10-24T13:00:00.000Z",
          });
        }
        if (url === "/v1/auth/me") {
          return json(200, {
            userId: "u1",
            tenantId: "t1",
            displayName: "Administrator",
            roles: ["system_admin"],
            permissions: ["asset:read"],
            mustChangeCredentials: true,
          });
        }
        return json(404, { error: { code: "not_found", message: "nope", requestId: "r" } });
      }),
    );

    completeToReview();
    fireEvent.click(screen.getByRole("button", { name: "Create tenant" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to sign-in" }));

    // The wizard signs in with the provisioning account, never asking the
    // operator to type it; App then swaps to the credential step.
    await waitFor(() => {
      expect(loginBody).toEqual({
        tenantSlug: "katsina-state",
        username: "admin",
        password: "password",
      });
    });
    expect(useSession.getState().user?.mustChangeCredentials).toBe(true);
  });
});
