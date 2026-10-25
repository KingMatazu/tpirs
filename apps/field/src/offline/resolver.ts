import { resolveOfflineScan as domainResolveOfflineScan } from "@tpirs/domain";

export type OfflineScanResult = "paid" | "not_in_offline_list";

export function resolveOfflineScan(token: string, paidPayloads: ReadonlySet<string>): OfflineScanResult | undefined {
  const result = domainResolveOfflineScan(token, paidPayloads);
  // Type-level guarantee: only paid or not_in_offline_list
  if (result === undefined) return undefined;
  return result;
}
