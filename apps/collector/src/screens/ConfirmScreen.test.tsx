import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmScreen } from "./ConfirmScreen.js";
import { testConfig } from "../test-support/tenant.js";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
// The fee engine's answer for the fixture's bike rule (₦200.00), mutable so one
// test can stand in for a vehicle the tenant has not priced today.
const fee = vi.hoisted(() => ({ minor: 20000n as bigint | undefined }));

vi.mock("../api/client.js", () => ({ api: { POST: post } }));

vi.mock("../session.js", () => ({
  useSession: Object.assign(() => undefined, { getState: () => ({}) }),
}));

const wallet = {
  collectorUserId: "collector-1",
  status: "active" as const,
  frozenReason: null,
  floatCeilingMinor: "5000000",
  balanceMinor: "1800000",
  openIntakeTotalMinor: "1800000",
  oldestOpenIntakeAt: null,
  lastDepositAt: null,
  depositInstruction: null,
};

vi.mock("../lib/data.js", () => ({
  useTenantConfig: () => testConfig(),
  useWallet: () => ({ data: { wallet, intakes: [] }, error: undefined, isLoading: false }),
  businessDateFor: () => "2026-11-03",
  resolveFeeMinor: () => Promise.resolve(fee.minor),
}));

const asset = {
  assetId: "asset-1",
  shortCode: "A000123",
  assetTypeKey: "bike",
  status: "active",
  attributes: { plate_number: "ABC123" },
  paymentStatus: "no_payment_recorded" as const,
  businessDate: "2026-11-03",
};

const noop = (): void => undefined;

describe("confirm screen fee", () => {
  beforeEach(() => {
    fee.minor = 20000n;
    post.mockReset();
    post.mockResolvedValue({ response: { ok: true }, data: { receiptNumber: "R-1" } });
  });

  it("shows the tenant's fee and offers no way to edit it", async () => {
    render(<ConfirmScreen asset={asset} onBack={noop} onDeposit={noop} onDone={noop} />);

    // The fee appears once as the day's price and once in the button label.
    expect((await screen.findAllByText(/200\.00/)).length).toBeGreaterThan(0);
    // No amount field: the fee is the state's, and the server checks it again.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
  });

  it("sends exactly the tenant's fee, not a typed amount", async () => {
    render(<ConfirmScreen asset={asset} onBack={noop} onDeposit={noop} onDone={noop} />);

    fireEvent.click(await screen.findByRole("button", { name: /cash received/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    const call = post.mock.calls[0]?.[1] as
      { body: { amountMinor: string; currency: string } } | undefined;
    expect(call?.body.amountMinor).toBe("20000");
    expect(call?.body.currency).toBe("NGN");
  });

  it("refuses the day when the tenant has no fee rule for the vehicle", async () => {
    fee.minor = undefined;
    render(<ConfirmScreen asset={asset} onBack={noop} onDeposit={noop} onDone={noop} />);

    expect(await screen.findByText(/No fee rule matches this vehicle today/i)).toBeTruthy();
    expect(screen.getByText(/nothing to collect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cash received/i })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
