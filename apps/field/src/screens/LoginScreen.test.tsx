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
function signIn(options: { totp?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "alpha-state" } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alpha.officer" } });
  fireEvent.change(screen.getByLabelText(/^password/i), {
    target: { value: "alpha-officer-password" },
  });
  if (options.totp !== undefined) {
    fireEvent.change(screen.getByLabelText(/authenticator code/i), {
      target: { value: options.totp },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginScreen", () => {
  beforeEach(() => {
    login.mockReset();
    globalThis.localStorage.clear();
  });

  it("signs in with the tenant, username, password and authenticator code", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    signIn({ totp: "123456" });
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        tenantSlug: "alpha-state",
        username: "alpha.officer",
        password: "alpha-officer-password",
        totpCode: "123456",
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

  it("sends no authenticator code when the field is left empty", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    signIn();
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(expect.objectContaining({ totpCode: "" }));
    });
  });
});
