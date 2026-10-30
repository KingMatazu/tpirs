import { useQuery } from "@tanstack/react-query";
import type { TenantConfig } from "@tpirs/config";
import { api } from "../api/client.js";
import { unwrap, type ApiResult } from "../api/unwrap.js";

/** { config, version } from GET /v1/tenants/current/config. */
export interface TenantConfigPayload {
  readonly config: TenantConfig;
  readonly version: number;
}

/**
 * What the shell needs to render: name, branding and locale. Every signed-in
 * staff member may read this (`GET /v1/tenants/current/branding`), while the
 * full config stays behind `tenant:read` — an officer should see the tenant's
 * colours and languages without seeing providers, cash rules or tolerances.
 */
export interface TenantBranding {
  readonly identity: { readonly name: string; readonly slug: string };
  readonly branding: TenantConfig["branding"];
  readonly locale: TenantConfig["locale"];
}

export function useTenantBranding(): Readonly<{
  branding: TenantBranding | undefined;
  isLoading: boolean;
  error: unknown;
}> {
  const query = useQuery({
    queryKey: ["tenant-branding"],
    queryFn: async () => {
      const result = await api.GET("/v1/tenants/current/branding");
      return await unwrap<TenantBranding>(
        result as unknown as Promise<ApiResult<TenantBranding>> | ApiResult<TenantBranding>,
      );
    },
    staleTime: 60_000,
  });
  return { branding: query.data, isLoading: query.isLoading, error: query.error };
}

/** The full config: the config viewer only, behind `tenant:read`. */
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
