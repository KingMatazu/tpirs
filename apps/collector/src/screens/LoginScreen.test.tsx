import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LoginScreen } from "./LoginScreen.js";

vi.mock("../session.js", () => ({
  useSession: {
    getState: () => ({ login: vi.fn() }),
  },
}));

describe("collector sign-in", () => {
  it("hides the password until the collector asks to see it", () => {
    render(<LoginScreen />);
    const password = screen.getByLabelText(/^password/i);
    expect(password.getAttribute("type")).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(password.getAttribute("type")).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /hide password/i }));
    expect(password.getAttribute("type")).toBe("password");
  });

  it("keeps what was typed while the visibility changes", () => {
    render(<LoginScreen />);
    const password = screen.getByLabelText(/^password/i);
    fireEvent.change(password, { target: { value: "alpha-collector-password" } });

    fireEvent.click(screen.getByRole("button", { name: /show password/i }));

    expect((password as HTMLInputElement).value).toBe("alpha-collector-password");
  });

  it("tells assistive technology whether the password is visible", () => {
    render(<LoginScreen />);
    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: /hide password/i }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
