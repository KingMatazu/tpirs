import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";

/**
 * The shell branch: a signed-in account still holding its temporary password
 * never reaches the scan home, because the server would refuse everything the
 * home screen does.
 */

const state = {
  status: "authenticated" as const,
  config: undefined,
  user: { displayName: "Aisha Bello", mustChangeCredentials: true },
  initialize: vi.fn(),
};

vi.mock("./session.js", () => ({
  useSession: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}));

describe("officer app shell", () => {
  it("shows the password screen instead of the scan home", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /choose your password/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /scan/i })).toBeNull();
  });
});
