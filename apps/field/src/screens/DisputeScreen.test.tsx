import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DisputeScreen } from "./DisputeScreen.js";
import { recordDispute } from "../lib/dispute.js";

vi.mock("../lib/dispute.js", () => ({ recordDispute: vi.fn() }));

const reasons = [
  { code: "already_paid", label: "Already paid" },
  { code: "wrong_location", label: "Wrong location" },
  { code: "other", label: "Other" },
];

const noop = (): void => undefined;

function renderScreen(onDone = noop): void {
  render(
    <DisputeScreen
      context={{ reference: "A000001", shortCode: "A000001" }}
      reasons={reasons}
      maxQueueItems={1000}
      onDone={onDone}
      onBack={noop}
    />,
  );
}

describe("DisputeScreen", () => {
  beforeEach(() => {
    vi.mocked(recordDispute).mockReset();
  });

  it("offers exactly the tenant's reasons", () => {
    renderScreen();
    for (const reason of reasons) {
      expect(screen.getByRole("button", { name: reason.label })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /technical issue/i })).toBeNull();
  });

  it("will not send without a reason", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));
    expect(await screen.findByText(/pick what happened/i)).toBeTruthy();
    expect(recordDispute).not.toHaveBeenCalled();
  });

  it("sends on the reason alone, with no description typed", async () => {
    vi.mocked(recordDispute).mockResolvedValue({ status: "recorded", disputeId: "d-1" });
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /already paid/i }));
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));

    await waitFor(() => {
      expect(recordDispute).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "already_paid", description: "" }),
      );
    });
  });

  it("sends the chosen reason and the officer's words", async () => {
    vi.mocked(recordDispute).mockResolvedValue({ status: "recorded", disputeId: "d-1" });
    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: /already paid/i }));
    fireEvent.change(screen.getByLabelText(/what did you see/i), {
      target: { value: "Driver showed a receipt from this morning." },
    });
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));

    await waitFor(() => {
      expect(recordDispute).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "already_paid",
          description: "Driver showed a receipt from this morning.",
          reference: "A000001",
          maxQueueItems: 1000,
        }),
      );
    });
  });

  it("gives every attempt its own id, so a retry cannot double-raise it", async () => {
    vi.mocked(recordDispute).mockResolvedValue({ status: "recorded", disputeId: "d-1" });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /other/i }));
    fireEvent.change(screen.getByLabelText(/what did you see/i), {
      target: { value: "Something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));

    await waitFor(() => {
      const attempt = vi.mocked(recordDispute).mock.calls[0]?.[0];
      expect(attempt?.clientDisputeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(attempt?.occurredAt).toBeDefined();
    });
  });

  it("tells the officer when the dispute is only saved on the phone", async () => {
    vi.mocked(recordDispute).mockResolvedValue({ status: "queued" });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /other/i }));
    fireEvent.change(screen.getByLabelText(/what did you see/i), {
      target: { value: "Something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));

    expect(await screen.findByText(/saved on this phone/i)).toBeTruthy();
  });

  it("says so when the office refuses it, instead of claiming success", async () => {
    vi.mocked(recordDispute).mockResolvedValue({ status: "rejected" });
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /other/i }));
    fireEvent.change(screen.getByLabelText(/what did you see/i), {
      target: { value: "Something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send dispute/i }));

    expect(await screen.findByText(/did not accept this dispute/i)).toBeTruthy();
  });

  it("marks the chosen reason for assistive technology", () => {
    renderScreen();
    const button = screen.getByRole("button", { name: /already paid/i });
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
