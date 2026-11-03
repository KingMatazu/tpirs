import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@tpirs/api-client";
import { SetPasswordScreen } from "./SetPasswordScreen.js";

const { changePassword, logout } = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logout: vi.fn(),
}));

const state = {
  user: { displayName: "Musa Collector", mustChangeCredentials: true },
};

vi.mock("../session.js", () => ({
  useSession: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => ({ changePassword, logout }) },
  ),
}));

function fill(password: string, confirmation = password): void {
  fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: confirmation },
  });
}

describe("collector first sign-in", () => {
  beforeEach(() => {
    changePassword.mockReset();
    logout.mockReset();
  });

  it("keeps the collector from the cash flow until a password is chosen", () => {
    render(<SetPasswordScreen />);
    expect(screen.getByRole("heading", { name: /choose your password/i })).toBeTruthy();
    expect(screen.getByText(/Musa Collector/)).toBeTruthy();
  });

  it("rejects a short password without asking the server", async () => {
    render(<SetPasswordScreen />);
    fill("short");
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    expect(await screen.findByText(/use at least 6 characters/i)).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("saves the chosen password", async () => {
    changePassword.mockResolvedValue(undefined);
    render(<SetPasswordScreen />);
    fill("collector-pass-1");
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledWith("collector-pass-1");
    });
  });

  it("shows the server's reason when the password is refused", async () => {
    changePassword.mockRejectedValue(
      new ApiError({
        status: 422,
        code: "unprocessable_entity",
        message: '"password" is not a password; choose another',
      }),
    );
    render(<SetPasswordScreen />);
    fill("password");
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    expect(await screen.findByText(/is not a password/i)).toBeTruthy();
  });

  it("lets the collector sign out", async () => {
    logout.mockResolvedValue(undefined);
    render(<SetPasswordScreen />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => {
      expect(logout).toHaveBeenCalled();
    });
  });
});
