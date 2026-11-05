import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Screen } from "./ui.js";
import { useSession } from "../session.js";
import { testConfig } from "../test-support/config.js";

afterEach(() => {
  cleanup();
  useSession.setState({ config: undefined });
});

describe("screen shell", () => {
  it("carries the firm's attribution at the foot of every screen", () => {
    useSession.setState({ config: testConfig() });
    render(<Screen title="Scan">body</Screen>);
    expect(screen.getByTestId("powered-by").textContent).toBe(
      "Powered by Star Galaxy Innovation and Technology Ltd",
    );
  });

  it("shows the state's mark beside the screen title once a tenant is known", () => {
    useSession.setState({ config: testConfig() });
    render(<Screen title="Scan">body</Screen>);
    // The fixture has a hosted logo, so it renders as an image. It is
    // decorative: the heading must still read "Scan", not "Alpha State Scan".
    expect(screen.getByRole("heading", { name: "Scan" })).toBeDefined();
  });

  it("shows the title alone before sign-in, when no config is cached", () => {
    useSession.setState({ config: undefined });
    render(<Screen title="Sign in">body</Screen>);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
  });
});
