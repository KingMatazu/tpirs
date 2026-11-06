import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@tpirs/api-client";
import { LoginScreen } from "./LoginScreen.js";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));

vi.mock("../session.js", () => ({
  useSession: {
    getState: () => ({ login }),
  },
}));

function apiError(status: number): ApiError {
  return new ApiError({ status, code: "unauthorized", message: "no" });
}

/**
 * Fills and submits with `fireEvent` rather than `userEvent.type`: typing four
 * fields character by character takes ~800 ms per test, and under a full-repo
 * run that is enough to trip the default timeout.
 */
function signIn(): void {
  fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "alpha-state" } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alpha.officer" } });
  fireEvent.change(screen.getByLabelText(/^password/i), {
    target: { value: "alpha-officer-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginScreen", () => {
  beforeEach(() => {
    login.mockReset();
    globalThis.localStorage.clear();
  });

  it("signs in with the tenant, username and password", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    signIn();
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        tenantSlug: "alpha-state",
        username: "alpha.officer",
        password: "alpha-officer-password",
      });
    });
  });

  it("remembers the tenant slug on this handset but never the username", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    signIn();
    await waitFor(() => {
      expect(globalThis.localStorage.getItem("tpirs.field.tenant")).toBe("alpha-state");
    });
    const stored = Object.keys(globalThis.localStorage).map(
      (key) => globalThis.localStorage.getItem(key) ?? "",
    );
    expect(stored.join(" ")).not.toContain("alpha.officer");
  });

  it("says the details were rejected rather than blaming the network", async () => {
    login.mockRejectedValue(apiError(401));
    render(<LoginScreen />);
    signIn();
    expect(await screen.findByText(/check the state, username and password/i)).toBeTruthy();
  });

  it("reports a throttle as a throttle", async () => {
    login.mockRejectedValue(apiError(429));
    render(<LoginScreen />);
    signIn();
    expect(await screen.findByText(/too many attempts/i)).toBeTruthy();
  });

  it("still lets an officer sign in when the handset says it has no connection", async () => {
    // Android reports `navigator.onLine === false` on a Wi-Fi network it cannot
    // reach the internet through, while the levy server on that same network is
    // perfectly reachable. Refusing to submit there locks the officer out of a
    // working system, so the banner is a hint and the request decides.
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
    Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: false });
    login.mockResolvedValue(undefined);
    try {
      render(<LoginScreen />);
      expect(screen.getByText(/reports no connection/i)).toBeTruthy();

      signIn();
      await waitFor(() => {
        expect(login).toHaveBeenCalledOnce();
      });
      // The request got through, so the hint is withdrawn.
      expect(screen.queryByText(/reports no connection/i)).toBeNull();
    } finally {
      if (original === undefined) {
        delete (globalThis.navigator as { onLine?: boolean }).onLine;
      } else {
        Object.defineProperty(globalThis.navigator, "onLine", original);
      }
    }
  });

  it("asks for nothing beyond the password", () => {
    render(<LoginScreen />);
    expect(screen.queryByLabelText(/authenticator code/i)).toBeNull();
    expect(screen.queryByLabelText(/two-factor/i)).toBeNull();
  });

  it("shows the password only when the officer asks", () => {
    render(<LoginScreen />);
    const password = screen.getByLabelText(/^password/i);
    expect(password.getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(password.getAttribute("type")).toBe("text");
  });
});
