import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App.js";
import { testConfig } from "./test-support/tenant.js";

const { initialize, logout } = vi.hoisted(() => ({
  initialize: vi.fn(),
  logout: vi.fn(),
}));

const state = {
  status: "authenticated" as "unknown" | "anonymous" | "authenticated",
  user: undefined as
    | {
        displayName: string;
        mustChangeCredentials: boolean;
        roles?: string[];
      }
    | undefined,
  initialize,
};

vi.mock("./session.js", () => ({
  useSession: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => ({ initialize, logout }),
  }),
}));

vi.mock("./lib/data.js", () => ({
  useTenantConfig: () => testConfig(),
  useWallet: () => ({ data: undefined, error: undefined, isLoading: false, refetch: vi.fn() }),
  businessDateFor: () => "2026-11-03",
}));

describe("collector app shell", () => {
  beforeEach(() => {
    state.status = "authenticated";
    state.user = {
      displayName: "Musa Collector",
      mustChangeCredentials: true,
      roles: ["collector"],
    };
    initialize.mockReset();
    logout.mockReset();
  });

  it("shows the password screen instead of the cash flow", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /choose your password/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /collect fee/i })).toBeNull();
  });

  it("opens the profile from the home header and signs out from there", () => {
    state.user = {
      displayName: "Musa Collector",
      mustChangeCredentials: false,
      roles: ["collector"],
    };
    render(<App />);

    expect(screen.getByRole("button", { name: /collect fee/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));

    expect(screen.getByRole("heading", { name: "Profile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
