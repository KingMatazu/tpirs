import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "./ToastHost.js";
import { useToasts } from "../toast.js";

afterEach(() => {
  cleanup();
  useToasts.setState({ toasts: [] });
});

describe("ToastHost", () => {
  it("renders a queued toast and dismisses it", async () => {
    useToasts.getState().push({
      kind: "error",
      message: "The request failed",
      requestId: "req-1",
      expireMs: 60_000,
    });

    render(<ToastHost />);

    expect(await screen.findByText("The request failed")).toBeTruthy();
    expect(screen.getByText("request id: req-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("The request failed")).toBeNull();
  });

  it("renders nothing when the queue is empty", () => {
    render(<ToastHost />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
