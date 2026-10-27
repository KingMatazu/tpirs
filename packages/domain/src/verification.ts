import { qrPayload } from "./asset.js";

/**
 * What the server can say about an asset's payment for one business day.
 *
 * `no_payment_recorded` is deliberately not called "unpaid": under the
 * `pay_per_use` model a day with no payment may simply be a day the vehicle
 * did not work, and absence of a record is not a debt (build brief section 6).
 * `unknown` is reserved for a tenant whose ledger or configuration cannot be
 * read; it is never inferred from a missing row.
 */
export type PaymentStatus = "paid" | "no_payment_recorded" | "unknown";

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "paid",
  "no_payment_recorded",
  "unknown",
];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The recorded status of one obligation period. `none` is what the obligation
 * service reports when no row exists, which is normal under `pay_per_use`.
 */
export type RecordedPeriodStatus = "none" | "unpaid" | "paid" | "waived";

/** Maps a period status (or no period) to the public payment vocabulary. */
export function paymentStatusFromPeriod(status: RecordedPeriodStatus | undefined): PaymentStatus {
  if (status === undefined) return "unknown";
  return status === "paid" || status === "waived" ? "paid" : "no_payment_recorded";
}

/**
 * What an offline phone is allowed to conclude. There are only two answers:
 * the asset is in the cached paid set, or it is not. There is no value that
 * means "unpaid", and no code path can produce one.
 */
export type OfflineScanResult = "paid" | "not_in_offline_list";

export const OFFLINE_SCAN_RESULTS: readonly OfflineScanResult[] = ["paid", "not_in_offline_list"];

export function isOfflineScanResult(value: string): value is OfflineScanResult {
  return (OFFLINE_SCAN_RESULTS as readonly string[]).includes(value);
}

const TOKEN_SEPARATOR = ".";
const CHECKSUM_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Splits a QR token into its opaque payload for offline paid-set lookup.
 *
 * This is a structural read, **not** an authenticity check: the HMAC key stays
 * on the server. Callers may only use the payload to look for membership in
 * the cached paid set. A malformed token returns `undefined` so the UI can ask
 * for a rescan rather than inventing a status.
 */
export function readQrPayload(token: string): string | undefined {
  const separatorIndex = token.lastIndexOf(TOKEN_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return undefined;
  const checksum = token.slice(separatorIndex + 1);
  if (!CHECKSUM_PATTERN.test(checksum)) return undefined;
  try {
    return qrPayload(token.slice(0, separatorIndex));
  } catch {
    return undefined;
  }
}

/**
 * Resolves a scanned token against the offline paid set.
 *
 * Returns `undefined` only when the sticker cannot be read. A readable payload
 * that is absent from the set is `not_in_offline_list`, never a denial of
 * payment.
 */
export function resolveOfflineScan(
  token: string,
  paidPayloads: ReadonlySet<string>,
): OfflineScanResult | undefined {
  const payload = readQrPayload(token);
  if (payload === undefined) return undefined;
  return paidPayloads.has(payload) ? "paid" : "not_in_offline_list";
}
