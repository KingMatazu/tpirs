import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TenantConfig } from "@tpirs/config";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { useUiLanguage } from "../lib/uiLanguage.js";
import { Layout } from "./Layout.js";

const fixture = loadFixtureConfig();

const alpha: TenantConfig = fixture;
const beta: TenantConfig = {
  ...fixture,
  identity: { ...fixture.identity, name: "Beta State", slug: "beta-state" },
  branding: {
    ...fixture.branding,
    appName: "Beta Levy",
    colors: { ...fixture.branding.colors, primary: "#123456" },
  },
  locale: {
    ...fixture.locale,
    enabledLanguages: ["fr", "en"],
    defaultLanguage: "fr",
    currency: "GHS",
  },
};

let current: TenantConfig = alpha;

const fakeFetch = vi.fn(async (input: unknown): Promise<Response> => {
  const request = input as Request;
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/v1/tenants/current/branding") {
    // The shell reads the branding projection, which every signed-in role may
    // read; the full config stays behind tenant:read.
    const { identity, branding, locale } = current;
    return json(200, {
      identity: { name: identity.name, slug: identity.slug },
      branding: JSON.parse(JSON.stringify(branding)),
      locale: JSON.parse(JSON.stringify(locale)),
    });
  }
  return json(404, { error: { code: "not_found", message: "nope", requestId: "r0" } });
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ALL_PERMISSIONS = [
  "asset:read",
  "payment:read",
  "cash:read",
  "reconciliation:read",
  "report:read",
  "dispute:read",
  "ledger:read",
  "tenant:read",
  "audit:read",
];

function renderShell(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSession.setState({
    status: "authenticated",
    accessToken: "tok",
    user: {
      userId: "u1",
      tenantId: "t1",
      displayName: "Ada",
      roles: ["finance_admin"],
      permissions: [...ALL_PERMISSIONS],
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Layout>
        <div>page</div>
      </Layout>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  stubRelativeRequests();
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  cleanup();
  useSession.setState({ status: "unknown", accessToken: undefined, user: undefined });
  useUiLanguage.setState({ language: undefined });
  fakeFetch.mockClear();
  document.getElementById("tpirs-theme")?.remove();
});

describe("tenant-aware shell", () => {
  it("themes and labels from the alpha fixture", async () => {
    current = alpha;
    renderShell();

    expect(await screen.findByText("Example Levy")).toBeTruthy();
    expect(screen.getByTestId("tenant-name").textContent).toBe("Example State");
    expect(screen.getByRole("button", { name: /Registry/ })).toBeTruthy();
    // Only English has a catalogue among the enabled languages.
    expect(screen.queryByLabelText("Language")).toBeNull();
    expect(document.title).toBe("Example Levy — Admin");
  });

  it("re-themes and re-labels from the beta fixture with no code change", async () => {
    current = beta;
    renderShell();

    expect(await screen.findByText("Beta Levy")).toBeTruthy();
    expect(screen.getByTestId("tenant-name").textContent).toBe("Beta State");
    // French is the tenant default and has a catalogue.
    expect(screen.getByRole("button", { name: /Registre/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rapprochement/ })).toBeTruthy();
    expect(document.title).toBe("Beta Levy — Admin");
    expect(document.getElementById("tpirs-theme")?.textContent).toContain("123456");

    // The language switch re-labels the shell without reloading.
    fireEvent.change(screen.getByLabelText("Langue"), { target: { value: "en" } });
    expect(screen.getByRole("button", { name: /Registry/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reconciliation/ })).toBeTruthy();
  });
});
