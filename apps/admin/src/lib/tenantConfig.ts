import { useQuery } from "@tanstack/react-query";
import type { TenantConfig } from "@tpirs/config";
import { api } from "../api/client.js";
import { unwrap, type ApiResult } from "../api/unwrap.js";

/** { config, version } from GET /v1/tenants/current/config. */
export interface TenantConfigPayload {
  readonly config: TenantConfig;
  readonly version: number;
}

export function useTenantConfig(): Readonly<{
  config: TenantConfigPayload | undefined;
  isLoading: boolean;
  error: unknown;
}> {
  const query = useQuery({
    queryKey: ["tenant-config"],
    queryFn: async () => {
      const result = await api.GET("/v1/tenants/current/config");
      return await unwrap<TenantConfigPayload>(
        result as unknown as
          Promise<ApiResult<TenantConfigPayload>> | ApiResult<TenantConfigPayload>,
      );
    },
    staleTime: 60_000,
  });
  return {
    config: query.data,
    isLoading: query.isLoading,
    error: query.error,
  };
}
