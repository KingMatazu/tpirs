import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";
import type { TenantConfig } from "@tpirs/config";
import { api, setFieldToken } from "./api/client.js";
import { deviceId, platform } from "./lib/device.js";
import { applyTheme, fetchConfig, readCachedConfig } from "./lib/tenant.js";

export interface FieldUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
}

export type SessionStatus = "unknown" | "anonymous" | "authenticated";

interface SessionState {
  readonly status: SessionStatus;
  readonly user: FieldUser | undefined;
  readonly config: TenantConfig | undefined;
  /** Set when sign-in succeeded but the tenant config could not be loaded. */
  readonly configError: boolean;
  login(input: {
    tenantSlug: string;
    username: string;
    password: string;
    totpCode?: string;
  }): Promise<void>;
  logout(): Promise<void>;
  initialize(): Promise<void>;
  hasPermission(permission: string): boolean;
}

interface MeResponse {
  readonly userId?: string;
  readonly tenantId?: string;
  readonly displayName?: string;
  readonly permissions?: readonly string[];
}

/**
 * The officer's session: a short-lived bearer in memory and the D26 refresh
 * cookie in the browser. Nothing about the session is persisted — a handset that
 * is lost or handed over must not still be signed in.
 */
export const useSession = create<SessionState>()((set, get) => ({
  status: "unknown",
  user: undefined,
  config: readCachedConfig(),
  configError: false,

  async login(input) {
    const result = await api.POST("/v1/auth/login", {
      body: {
        tenantSlug: input.tenantSlug,
        username: input.username,
        password: input.password,
        ...(input.totpCode === undefined || input.totpCode.trim() === ""
          ? {}
          : { totpCode: input.totpCode.trim() }),
        // Device binding: the server records which handset signed in. It does
        // not refuse a new one yet, so this is an audit trail, not a lock.
        device: { deviceId: deviceId(), platform: platform() },
      },
    });
    if (!result.response.ok) {
      throw new ApiError({
        status: result.response.status,
        code: result.response.status === 429 ? "rate_limited" : "unauthorized",
        message: "Those details were not accepted.",
      });
    }
    const token = result.data?.token;
    if (typeof token !== "string" || token === "") {
      throw new ApiError({ status: 500, code: "error", message: "Sign-in returned no token" });
    }
    setFieldToken(token);

    const user = await loadMe();
    if (user === undefined) {
      setFieldToken(undefined);
      throw new ApiError({
        status: 401,
        code: "unauthorized",
        message: "Signed in, but the session details could not be loaded",
      });
    }

    let config: TenantConfig | undefined;
    let configError = false;
    try {
      config = await fetchConfig();
      if (config === undefined) configError = true;
    } catch {
      // Branding is not worth blocking a shift over; the cached copy renders.
      configError = true;
    }
    const effective = config ?? get().config ?? readCachedConfig();
    if (effective !== undefined) applyTheme(effective);

    set({ status: "authenticated", user, config: effective, configError });
  },

  async logout() {
    try {
      await api.POST("/v1/auth/logout", { credentials: "same-origin" });
    } catch {
      // The local session is cleared regardless; the token expires on its own.
    }
    setFieldToken(undefined);
    set({ status: "anonymous", user: undefined });
  },

  async initialize() {
    if (get().status !== "unknown") return;
    const cached = readCachedConfig();
    if (cached !== undefined) applyTheme(cached);
    try {
      const refreshed = await api.POST("/v1/auth/refresh", { credentials: "same-origin" });
      const token = refreshed.data?.token;
      if (typeof token !== "string" || token === "") {
        set({ status: "anonymous", config: cached });
        return;
      }
      setFieldToken(token);
      const user = await loadMe();
      if (user === undefined) {
        setFieldToken(undefined);
        set({ status: "anonymous", config: cached });
        return;
      }
      set({ status: "authenticated", user, config: cached });
    } catch {
      // Offline at launch is normal in the field: the cached config still
      // renders the sign-in screen, and the officer signs in when back online.
      set({ status: "anonymous", config: cached });
    }
  },

  hasPermission(permission) {
    return get().user?.permissions.includes(permission) ?? false;
  },
}));

async function loadMe(): Promise<FieldUser | undefined> {
  const me = await api.GET("/v1/auth/me");
  const body = me.data as MeResponse | undefined;
  if (body?.userId === undefined || body.tenantId === undefined) return undefined;
  return {
    userId: body.userId,
    tenantId: body.tenantId,
    displayName: body.displayName ?? "Officer",
    permissions: body.permissions ?? [],
  };
}
