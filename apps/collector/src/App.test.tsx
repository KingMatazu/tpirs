import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";

/** A collector holding a temporary password never reaches the cash flow. */

const state = {
  status: "authenticated" as const,
  user: { displayName: "Musa Collector", mustChangeCredentials: true },
  initialize: vi.fn(),
};

vi.mock("./session.js", () => ({
  useSession: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}));

describe("collector app shell", () => {
  it("shows the password screen instead of the cash flow", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /choose your password/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /collect fee/i })).toBeNull();
  });
});
