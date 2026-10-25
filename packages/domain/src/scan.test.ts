import { describe, expect, it } from "vitest";
import {
  isClientCommandId,
  isObservedScanStatus,
  isPlausibleScanTime,
  isScanSource,
  isValidCoordinate,
  MAX_SCAN_CLOCK_SKEW_MS,
} from "./scan.js";

describe("scan vocabulary", () => {
  it("accepts only known sources", () => {
    expect(isScanSource("qr")).toBe(true);
    expect(isScanSource("offline_queue")).toBe(true);
    expect(isScanSource("camera")).toBe(false);
  });

  it("accepts the observed statuses a screen can show, never 'unpaid'", () => {
    expect(isObservedScanStatus("not_in_offline_list")).toBe(true);
    expect(isObservedScanStatus("no_payment_recorded")).toBe(true);
    expect(isObservedScanStatus("unpaid")).toBe(false);
  });

  it("validates client command ids as UUIDs", () => {
    expect(isClientCommandId("6f2c1e7a-3b4d-4c8e-9f10-2a3b4c5d6e7f")).toBe(true);
    expect(isClientCommandId("not-a-uuid")).toBe(false);
  });
});

describe("scan timestamps and coordinates", () => {
  const now = new Date("2026-10-24T10:00:00.000Z");

  it("allows old offline timestamps but rejects far-future ones", () => {
    expect(isPlausibleScanTime(new Date("2026-10-20T09:00:00.000Z"), now)).toBe(true);
    expect(isPlausibleScanTime(new Date(now.getTime() + 1000), now)).toBe(true);
    expect(isPlausibleScanTime(new Date(now.getTime() + MAX_SCAN_CLOCK_SKEW_MS + 1), now)).toBe(
      false,
    );
    expect(isPlausibleScanTime(new Date("nonsense"), now)).toBe(false);
  });

  it("validates optional coordinates", () => {
    expect(isValidCoordinate(6.5244, 3.3792)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
  });
});
