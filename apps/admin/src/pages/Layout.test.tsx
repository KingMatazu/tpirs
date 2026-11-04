import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { TenantConfig } from "@tpirs/config";
import { useSession } from "../session.js";
import { stubRelativeRequests } from "../test-support/browserStubs.js";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { useUiLanguage } from "../lib/uiLanguage.js";
import { Layout, firstPermittedRoute, permissionForRoute } from "./Layout.js";

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
  if (url.pathname === "/v1/tenants/current/config") {
    return json(200, { config: JSON.parse(JSON.stringify(current)), version: 1 });
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

describe("route permissions", () => {
  it("knows which permission a route needs", () => {
    expect(permissionForRoute("/registry")).toBe("asset:read");
    expect(permissionForRoute("/audit")).toBe("audit:read");
    expect(permissionForRoute("/nope")).toBeUndefined();
  });

  it("lands a role on a page its own sidebar shows", () => {
    // A system admin used to be dropped on /registry while holding no asset:read.
    expect(firstPermittedRoute(["tenant:read", "audit:read"])).toBe("/channels");
    expect(firstPermittedRoute(["asset:read"])).toBe("/registry");
    expect(firstPermittedRoute(["report:read", "asset:read"])).toBe("/registry");
  });

  it("returns nothing for an account with no permissions at all", () => {
    expect(firstPermittedRoute([])).toBeUndefined();
  });
});

type MediaListener = (event: { readonly matches: boolean }) => void;

/**
 * A controllable `matchMedia`, because jsdom has none and the drawer's
 * auto-collapse is driven by one query changing.
 */
function stubMatchMedia(initial: boolean): { readonly setMatches: (matches: boolean) => void } {
  const state = { matches: initial };
  const listeners = new Set<MediaListener>();
  const list = {
    get matches() {
      return state.matches;
    },
    media: "(min-width: 1024px)",
    addEventListener: (_event: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", () => list);
  return {
    setMatches: (matches: boolean) => {
      state.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
}

describe("responsive navigation", () => {
  afterEach(() => {
    // Only the media stub is ours; `fetch` is installed for the whole file.
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fakeFetch);
  });

  it("keeps the sidebar in the page and the drawer closed until asked", async () => {
    current = alpha;
    renderShell();
    await screen.findByText("Example Levy");

    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open navigation" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("opens the drawer from the header, moves focus into it, and Escape returns focus", async () => {
    current = alpha;
    renderShell();
    await screen.findByText("Example Levy");

    const toggle = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(toggle);

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Close navigation" }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("closes on the backdrop, and after choosing a page", async () => {
    current = alpha;
    renderShell();
    await screen.findByText("Example Levy");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByTestId("nav-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Registry/ }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.hash).toBe("#/registry");
  });

  it("keeps Tab inside the open drawer", async () => {
    current = alpha;
    renderShell();
    await screen.findByText("Example Levy");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    const close = within(dialog).getByRole("button", { name: "Close navigation" });
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the first control wraps to the last page in the list.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /Audit/ }));

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("auto-collapses when the window grows past the breakpoint", async () => {
    const media = stubMatchMedia(false);
    current = alpha;
    renderShell();
    await screen.findByText("Example Levy");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();

    // A phone rotated to landscape, or a desktop window: the drawer must not
    // survive into a layout that has a permanent sidebar.
    act(() => {
      media.setMatches(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("labels the menu from the tenant's language", async () => {
    current = beta;
    renderShell();
    await screen.findByText("Beta Levy");

    expect(screen.getByRole("button", { name: "Ouvrir la navigation" })).toBeTruthy();
  });
});
