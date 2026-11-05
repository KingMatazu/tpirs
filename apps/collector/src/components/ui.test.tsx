import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Screen } from "./ui.js";
import { testConfig } from "../test-support/tenant.js";

/**
 * The shared phone shell: the firm's line at the foot of every screen, and the
 * state's mark beside the title once the tenant config has loaded.
 */
vi.mock("../lib/data.js", () => ({
  useTenantConfig: () => testConfig(),
}));

afterEach(() => {
  cleanup();
});

function renderScreen(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Screen title="Home">body</Screen>
    </QueryClientProvider>,
  );
}

describe("collector screen shell", () => {
  it("carries the firm's attribution at the foot of every screen", () => {
    renderScreen();
    expect(screen.getByTestId("powered-by").textContent).toBe(
      "Powered by Star Galaxy Innovation and Technology Ltd",
    );
  });

  it("keeps the heading readable while the state's logo sits beside it", () => {
    renderScreen();
    expect(screen.getByRole("heading", { name: "Home" })).toBeDefined();
  });
});
