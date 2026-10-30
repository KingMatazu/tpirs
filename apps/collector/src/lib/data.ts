import { useQuery } from "@tanstack/react-query";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import { businessDate } from "@tpirs/domain";
import type { AssetTypeId, TenantId } from "@tpirs/domain";
import type { TenantConfig } from "@tpirs/config";
import { api } from "../api/client.js";
import { useSession } from "../session.js";
import type { WalletView } from "./flow.js";

/** Shapes the collector app reads. Kept local: the generated types are broad. */
export interface IntakeRow {
  readonly id: string;
  readonly businessDate: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly receiptNumber: string;
  readonly assetId: string;
  readonly createdAt: string;
}

export interface WalletPayload {
  readonly wallet: WalletView;
  readonly intakes: readonly IntakeRow[];
}

export function useWallet(): {
  readonly data: WalletPayload | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly refetch: () => Promise<unknown>;
} {
  const userId = useSession((state) => state.user?.userId);
  const query = useQuery({
    queryKey: ["collector-wallet", userId],
    queryFn: async () => {
      const result = await api.GET("/v1/cash/wallets/{collectorUserId}", {
        params: { path: { collectorUserId: userId ?? "" }, query: { limit: "50" } },
      });
      if (!result.response.ok) {
        throw new Error("Your wallet could not be loaded.");
      }
      return result.data as unknown as WalletPayload;
    },
    enabled: userId !== undefined && userId !== "",
  });
  return {
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

export function useTenantConfig(): TenantConfig | undefined {
  const query = useQuery({
    queryKey: ["collector-tenant-config"],
    queryFn: async () => {
      const result = await api.GET("/v1/tenants/current/config");
      return (result.data as unknown as { config: TenantConfig } | undefined)?.config;
    },
    staleTime: 60_000,
  });
  return query.data;
}

/**
 * The fee for one asset today, resolved with the same engine the API uses, so
 * the phone shows the amount the server will check rather than a second opinion.
 */
export async function resolveFeeMinor(
  config: TenantConfig,
  assetTypeKey: string,
  businessDateValue: string,
): Promise<bigint | undefined> {
  const engine = createConfigFeeEngine({ loadConfig: () => Promise.resolve(config) });
  try {
    const resolved = await engine.resolveFee({
      // The ids are opaque at the type level; the values come from validated
      // config and a computed date, so the boundary cast is the honest place.
      tenantId: config.identity.slug as TenantId,
      assetType: assetTypeKey as AssetTypeId,
      businessDate: businessDate(businessDateValue),
    });
    return BigInt(resolved.amountMinor);
  } catch {
    return undefined;
  }
}

/** Today in the tenant's timezone, the date the fee and the paid set use. */
export function businessDateFor(config: TenantConfig | undefined, now: Date = new Date()): string {
  const timeZone = config?.locale.timezone ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}
