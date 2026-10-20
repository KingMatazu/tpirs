import { InvalidIdError } from "./errors.js";

declare const opaqueIdBrand: unique symbol;

export type OpaqueId<T extends string> = string & { readonly [opaqueIdBrand]: T };

export type TenantId = OpaqueId<"TenantId">;
export type ZoneId = OpaqueId<"ZoneId">;
export type AssetId = OpaqueId<"AssetId">;
export type AssetTypeId = OpaqueId<"AssetTypeId">;
export type OwnerId = OpaqueId<"OwnerId">;
export type CollectorId = OpaqueId<"CollectorId">;
export type OfficerId = OpaqueId<"OfficerId">;
export type PaymentId = OpaqueId<"PaymentId">;
export type ObligationPeriodId = OpaqueId<"ObligationPeriodId">;
export type LedgerEntryId = OpaqueId<"LedgerEntryId">;
export type TransactionId = OpaqueId<"TransactionId">;
export type UserId = OpaqueId<"UserId">;
export type DisputeId = OpaqueId<"DisputeId">;

function opaqueId<T extends string>(idType: T, value: string): OpaqueId<T> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidIdError(idType, `${idType} must be a non-empty string`);
  }
  return trimmed as OpaqueId<T>;
}

export const tenantId = (value: string): TenantId => opaqueId("TenantId", value);
export const zoneId = (value: string): ZoneId => opaqueId("ZoneId", value);
export const assetId = (value: string): AssetId => opaqueId("AssetId", value);
export const assetTypeId = (value: string): AssetTypeId => opaqueId("AssetTypeId", value);
export const ownerId = (value: string): OwnerId => opaqueId("OwnerId", value);
export const collectorId = (value: string): CollectorId => opaqueId("CollectorId", value);
export const officerId = (value: string): OfficerId => opaqueId("OfficerId", value);
export const paymentId = (value: string): PaymentId => opaqueId("PaymentId", value);
export const obligationPeriodId = (value: string): ObligationPeriodId =>
  opaqueId("ObligationPeriodId", value);
export const ledgerEntryId = (value: string): LedgerEntryId => opaqueId("LedgerEntryId", value);
export const transactionId = (value: string): TransactionId => opaqueId("TransactionId", value);
export const userId = (value: string): UserId => opaqueId("UserId", value);
export const disputeId = (value: string): DisputeId => opaqueId("DisputeId", value);
