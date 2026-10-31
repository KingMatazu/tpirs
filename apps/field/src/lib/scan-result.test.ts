import { describe, expect, it } from "vitest";
import {
  viewFromQueueFull,
  viewFromQueued,
  viewFromRejected,
  viewFromServer,
} from "./scan-result.js";
import type { ServerScanResult } from "./scan-result.js";
import type { ScanOutcome } from "./scan.js";

function serverResult(overrides: Partial<ServerScanResult> = {}): ServerScanResult {
  return {
    scanId: "scan-1",
    assetId: "asset-1",
    businessDate: "2026-06-15",
    observedStatus: "paid",
    authoritativeStatus: "paid",
    paymentStatus: "paid",
    shortCode: "A000001",
    ...overrides,
  };
}

function offline(kind: ScanOutcome["kind"]): ScanOutcome {
  return { kind, via: "token", businessDate: "2026-06-15" };
}

describe("viewFromServer", () => {
  it("takes the ledger's status and marks the scan as recorded", () => {
    const view = viewFromServer(serverResult(), "paid");
    expect(view.verdict).toBe("paid");
    expect(view.recorded).toBe("server");
    expect(view.scanId).toBe("scan-1");
    expect(view.corrected).toBe(false);
  });

  it("shows a ledger with no payment as no payment recorded, not as a debt", () => {
    const view = viewFromServer(
      serverResult({
        authoritativeStatus: "no_payment_recorded",
        paymentStatus: "no_payment_recorded",
      }),
      "not_in_offline_list",
    );
    expect(view.verdict).toBe("no_payment_recorded");
    // The cache did not claim a payment, so the ledger did not correct it.
    expect(view.corrected).toBe(false);
  });

  it("flags a correction when the cache said paid and the ledger disagrees", () => {
    const view = viewFromServer(
      serverResult({ authoritativeStatus: "no_payment_recorded" }),
      "paid",
    );
    expect(view.verdict).toBe("no_payment_recorded");
    expect(view.corrected).toBe(true);
  });

  it("does not flag a correction when both agree the vehicle is paid", () => {
    expect(viewFromServer(serverResult(), "paid").corrected).toBe(false);
  });

  it("carries an unknown ledger answer through untouched", () => {
    const view = viewFromServer(
      serverResult({ authoritativeStatus: "unknown" }),
      "not_in_offline_list",
    );
    expect(view.verdict).toBe("unknown");
    expect(view.recorded).toBe("server");
  });
});

describe("viewFromQueued", () => {
  it("keeps the offline answer and says the scan has not uploaded", () => {
    const view = viewFromQueued(offline("not_in_offline_list"));
    expect(view.verdict).toBe("not_in_offline_list");
    expect(view.recorded).toBe("queued");
  });

  it("does not queue an unreadable sticker, because there is nothing to send", () => {
    const view = viewFromQueued(offline("unreadable"));
    expect(view.recorded).toBe("none");
  });
});

describe("viewFromRejected", () => {
  it("calls a sticker the server does not know unrecognised", () => {
    const view = viewFromRejected(offline("not_in_offline_list"));
    expect(view.verdict).toBe("unreadable");
    expect(view.recorded).toBe("none");
  });
});

describe("viewFromQueueFull", () => {
  it("keeps the answer but does not claim the scan is safe", () => {
    const view = viewFromQueueFull(offline("paid"));
    expect(view.verdict).toBe("paid");
    expect(view.recorded).toBe("none");
  });
});
