import type { ScanOutcome } from "./scan.js";

/**
 * What the officer sees after a scan, and where the answer came from.
 *
 * Two sources meet here: the phone's cached paid set (fast, works in a dead
 * zone, can only confirm a payment) and the server's ledger (authoritative, but
 * needs a network). The view keeps them apart on purpose — an officer has to be
 * able to tell "recorded" from "will sync" — and never lets the cache overrule
 * the ledger.
 */
export type Verdict =
  "paid" | "no_payment_recorded" | "not_in_offline_list" | "unknown" | "unreadable";

export type RecordedState = "server" | "queued" | "none";

export interface ScanView {
  readonly verdict: Verdict;
  readonly recorded: RecordedState;
  readonly shortCode?: string;
  readonly attributes?: Record<string, unknown>;
  readonly businessDate?: string;
  /** The ledger disagrees with what the cache showed before the upload. */
  readonly corrected: boolean;
  readonly scanId?: string;
}

/** The subset of `POST /v1/scans` this app relies on. */
export interface ServerScanResult {
  readonly scanId: string;
  readonly assetId: string;
  readonly businessDate: string;
  readonly observedStatus: string;
  readonly authoritativeStatus: "paid" | "no_payment_recorded" | "unknown";
  readonly paymentStatus: "paid" | "no_payment_recorded" | "unknown";
  readonly shortCode?: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * The server answered: its status wins, and if it contradicts what the cache
 * said, the card says so instead of quietly changing its mind.
 */
export function viewFromServer(result: ServerScanResult, observed: Verdict): ScanView {
  const verdict: Verdict = result.authoritativeStatus;
  return {
    verdict,
    recorded: "server",
    corrected: observed === "paid" && verdict !== "paid",
    scanId: result.scanId,
    businessDate: result.businessDate,
    ...(result.shortCode === undefined ? {} : { shortCode: result.shortCode }),
    ...(result.attributes === undefined ? {} : { attributes: result.attributes }),
  };
}

/** The scan is queued; the card shows the offline answer and says it will sync. */
export function viewFromQueued(outcome: ScanOutcome): ScanView {
  return {
    verdict: outcome.kind,
    recorded: outcome.kind === "unreadable" ? "none" : "queued",
    corrected: false,
    ...(outcome.shortCode === undefined ? {} : { shortCode: outcome.shortCode }),
    ...(outcome.attributes === undefined ? {} : { attributes: outcome.attributes }),
    ...(outcome.businessDate === undefined ? {} : { businessDate: outcome.businessDate }),
  };
}

/**
 * The upload failed in a way that will not fix itself (the server does not know
 * this sticker), so nothing is queued and the officer is told to check the
 * sticker rather than wait for a sync that would never succeed.
 */
export function viewFromRejected(outcome: ScanOutcome): ScanView {
  return {
    verdict: "unreadable",
    recorded: "none",
    corrected: false,
    ...(outcome.businessDate === undefined ? {} : { businessDate: outcome.businessDate }),
  };
}

/** A queued scan that could not be stored: the phone's queue is full. */
export function viewFromQueueFull(outcome: ScanOutcome): ScanView {
  return {
    verdict: outcome.kind,
    recorded: "none",
    corrected: false,
    ...(outcome.shortCode === undefined ? {} : { shortCode: outcome.shortCode }),
    ...(outcome.attributes === undefined ? {} : { attributes: outcome.attributes }),
    ...(outcome.businessDate === undefined ? {} : { businessDate: outcome.businessDate }),
  };
}

/**
 * Every verdict is a statement about the *record*, never about the driver. The
 * word "unpaid" is banned here (and asserted against in the tests): under
 * pay-per-use a day without payment is not a debt.
 */
export function isNegativeVerdict(verdict: Verdict): boolean {
  return verdict === "not_in_offline_list" || verdict === "no_payment_recorded";
}
