import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

async function fillAndSubmit(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/state/i), "alpha-state");
  await user.type(screen.getByLabelText(/username/i), "alpha.officer");
  await user.type(screen.getByLabelText(/^password/i), "alpha-officer-password");
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginScreen", () => {
  beforeEach(() => {
    login.mockReset();
    globalThis.localStorage.clear();
  });

  it("signs in with the tenant, username, password and authenticator code", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/authenticator code/i), "123456");
    await fillAndSubmit();
    expect(login).toHaveBeenCalledWith({
      tenantSlug: "alpha-state",
      username: "alpha.officer",
      password: "alpha-officer-password",
      totpCode: "123456",
    });
  });

  it("remembers the tenant slug on this handset but never the username", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(globalThis.localStorage.getItem("tpirs.field.tenant")).toBe("alpha-state");
    const stored = Object.keys(globalThis.localStorage).map(
      (key) => globalThis.localStorage.getItem(key) ?? "",
    );
    expect(stored.join(" ")).not.toContain("alpha.officer");
  });

  it("says the details were rejected rather than blaming the network", async () => {
    login.mockRejectedValue(apiError(401));
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(await screen.findByText(/check the state, username and password/i)).toBeTruthy();
  });

  it("reports a throttle as a throttle", async () => {
    login.mockRejectedValue(apiError(429));
    render(<LoginScreen />);
    await fillAndSubmit();
    expect(await screen.findByText(/too many attempts/i)).toBeTruthy();
  });
});
