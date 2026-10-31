import { readQrPayload, resolveOfflineScan } from "@tpirs/domain";
import {
  allPaidPayloads,
  findPaidByPayload,
  findPaidByReference,
  readSyncState,
} from "../offline/store.js";

/**
 * The three answers a scan can produce while offline.
 *
 * `not_in_offline_list` is the only honest negative: the phone knows who paid
 * today, and it does not know who did not. `unreadable` is about the sticker or
 * the camera, never about the driver.
 */
export type ScanOutcomeKind = "paid" | "not_in_offline_list" | "unreadable";

export interface ScanOutcome {
  readonly kind: ScanOutcomeKind;
  readonly via: "token" | "reference";
  readonly shortCode?: string;
  readonly attributes?: Record<string, unknown>;
  readonly businessDate?: string;
}

export interface ScanInput {
  readonly token?: string;
  readonly reference?: string;
}

/**
 * Resolves a scan against the cached paid set only.
 *
 * Recording the scan and asking the server are separate steps: this function is
 * the offline answer, and it never claims more than the cache can support.
 */
export async function resolveScanOffline(input: ScanInput): Promise<ScanOutcome> {
  const businessDate = (await readSyncState())?.businessDate;

  if (input.token !== undefined && input.token !== "") {
    const result = resolveOfflineScan(input.token, await allPaidPayloads());
    if (result === undefined) return { kind: "unreadable", via: "token" };
    const payload = readQrPayload(input.token);
    const record = payload === undefined ? undefined : await findPaidByPayload(payload);
    return {
      kind: result,
      via: "token",
      ...(record === undefined
        ? {}
        : { shortCode: record.shortCode, attributes: record.attributes }),
      ...(businessDate === undefined ? {} : { businessDate }),
    };
  }

  const record = await findPaidByReference(input.reference ?? "");
  if (record === undefined) {
    return {
      kind: "not_in_offline_list",
      via: "reference",
      ...(businessDate === undefined ? {} : { businessDate }),
    };
  }
  return {
    kind: "paid",
    via: "reference",
    shortCode: record.shortCode,
    attributes: record.attributes,
    businessDate: record.businessDate,
  };
}
