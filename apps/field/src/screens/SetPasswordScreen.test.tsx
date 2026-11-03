import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@tpirs/api-client";
import { SetPasswordScreen } from "./SetPasswordScreen.js";

/**
 * First sign-in for a created account. The screen must not call the server with
 * a password it already knows is unusable, must say which field the server
 * refused, and must leave a way out for someone holding the wrong card.
 */

const { changePassword, logout } = vi.hoisted(() => ({
  changePassword: vi.fn(),
  logout: vi.fn(),
}));

const state = {
  user: { displayName: "Aisha Bello", mustChangeCredentials: true },
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

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
}

describe("officer first sign-in", () => {
  beforeEach(() => {
    changePassword.mockReset();
    logout.mockReset();
  });

  it("names the person whose temporary password is being replaced", () => {
    render(<SetPasswordScreen />);
    expect(screen.getByText(/Aisha Bello/)).toBeTruthy();
    expect(screen.getByText(/temporary one stops working/i)).toBeTruthy();
  });

  it("rejects a short password without asking the server", async () => {
    render(<SetPasswordScreen />);
    fill("short");
    submit();

    expect(await screen.findByText(/use at least 6 characters/i)).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("rejects a confirmation that does not match", async () => {
    render(<SetPasswordScreen />);
    fill("officer-pass-1", "officer-pass-2");
    submit();

    expect(await screen.findByText(/do not match/i)).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("saves the chosen password", async () => {
    changePassword.mockResolvedValue(undefined);
    render(<SetPasswordScreen />);
    fill("officer-pass-1");
    submit();

    await waitFor(() => {
      expect(changePassword).toHaveBeenCalledWith("officer-pass-1");
    });
  });

  it("shows the server's reason when the password is refused", async () => {
    changePassword.mockRejectedValue(
      new ApiError({
        status: 422,
        code: "unprocessable_entity",
        message: "The password must not be the username",
      }),
    );
    render(<SetPasswordScreen />);
    fill("aisha.bello");
    submit();

    expect(await screen.findByText(/must not be the username/i)).toBeTruthy();
  });

  it("lets the officer sign out with the card in the wrong hand", async () => {
    logout.mockResolvedValue(undefined);
    render(<SetPasswordScreen />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => {
      expect(logout).toHaveBeenCalled();
    });
  });
});
