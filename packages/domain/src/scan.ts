import type { PaymentStatus } from "./verification.js";

/** How the officer resolved the asset. */
export type ScanSource = "qr" | "manual" | "offline_queue";

export const SCAN_SOURCES: readonly ScanSource[] = ["qr", "manual", "offline_queue"];

export function isScanSource(value: string): value is ScanSource {
  return (SCAN_SOURCES as readonly string[]).includes(value);
}

/**
 * The status the officer's screen showed. Offline screens can only produce
 * `paid` or `not_in_offline_list`; online screens show the server status. The
 * server stores this next to the status it recomputes so divergence between an
 * offline observation and current data stays visible.
 */
export type ObservedScanStatus = PaymentStatus | "not_in_offline_list";

export const OBSERVED_SCAN_STATUSES: readonly ObservedScanStatus[] = [
  "paid",
  "no_payment_recorded",
  "unknown",
  "not_in_offline_list",
];

export function isObservedScanStatus(value: string): value is ObservedScanStatus {
  return (OBSERVED_SCAN_STATUSES as readonly string[]).includes(value);
}

/**
 * Client-generated command ids are UUIDs. Validation is deliberately
 * structural: the value is an idempotency key, not a security boundary.
 */
const CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isClientCommandId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

/** A scan timestamp may lead the server clock by at most this much. */
export const MAX_SCAN_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * True when a client timestamp is plausible relative to the server clock.
 * Queued offline scans may be old; only future timestamps need limiting.
 */
export function isPlausibleScanTime(
  scannedAt: Date,
  serverNow: Date,
  maxSkewMs = MAX_SCAN_CLOCK_SKEW_MS,
): boolean {
  if (Number.isNaN(scannedAt.getTime())) return false;
  return scannedAt.getTime() <= serverNow.getTime() + maxSkewMs;
}

/** Coordinates are optional; when supplied they must be real. */
export function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
