import { InvalidIdError } from "./errors.js";

/**
 * Asset lifecycle. An asset is registered, may be suspended (e.g. fraud,
 * lost sticker), and may be retired. Verification treats only `active` assets as
 * payable; suspension never deletes history.
 */
export type AssetStatus = "active" | "suspended" | "retired";

export const ASSET_STATUSES: readonly AssetStatus[] = ["active", "suspended", "retired"];

export function isAssetStatus(value: string): value is AssetStatus {
  return (ASSET_STATUSES as readonly string[]).includes(value);
}

/** Free-form, tenant-defined attributes validated by the AssetSchemaRegistry. */
export type AssetAttributes = Readonly<Record<string, unknown>>;

/**
 * The pure view of a registered asset. Persistence and identifiers live in the
 * repositories; this is what domain rules reason about.
 */
export interface Asset {
  readonly id: string;
  readonly tenantId: string;
  readonly zoneId: string | null;
  readonly ownerId: string | null;
  readonly assetTypeKey: string;
  readonly status: AssetStatus;
  readonly attributes: AssetAttributes;
  readonly qrToken: string;
  readonly shortCode: string;
}

declare const qrPayloadBrand: unique symbol;

/**
 * The opaque payload encoded before checksumming. It reveals nothing about the
 * tenant, owner, or fee; only a random public identifier.
 */
export type QrPayload = string & { readonly [qrPayloadBrand]: true };

const QR_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function qrPayload(value: string): QrPayload {
  if (!QR_PAYLOAD_PATTERN.test(value)) {
    throw new InvalidIdError(
      "QrPayload",
      `QR payload "${value}" must be 16-64 URL-safe characters`,
    );
  }
  return value as QrPayload;
}
