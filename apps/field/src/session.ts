import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";
import type { TenantConfig } from "@tpirs/config";
import { api, apiCredentials, setFieldToken } from "./api/client.js";
import { deviceId, platform } from "./lib/device.js";
import { applyTheme, fetchConfig, readCachedConfig } from "./lib/tenant.js";

export interface FieldUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
  /**
   * True while the account still holds the temporary password an administrator
   * handed over. The server refuses every other route in that state, so the app
   * shows the password screen and nothing else.
   */
  readonly mustChangeCredentials: boolean;
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
  /**
   * Replaces the temporary password at first sign-in. The server ends the
   * session that authorised the old password and issues a new one, which this
   * stores so the officer does not sign in twice.
   */
  changePassword(password: string): Promise<void>;
  logout(): Promise<void>;
  initialize(): Promise<void>;
  /** Renews the bearer from the refresh cookie. False when the session is gone. */
  refresh(): Promise<boolean>;
  hasPermission(permission: string): boolean;
}

interface MeResponse {
  readonly userId?: string;
  readonly tenantId?: string;
  readonly displayName?: string;
  readonly permissions?: readonly string[];
  readonly mustChangeCredentials?: boolean;
}

/**
 * The officer's session: a short-lived bearer in memory and the D26 refresh
 * cookie in the browser. Nothing about the session is persisted — a handset that
 * is lost or handed over must not still be signed in.
 */
/**
 * The in-flight bootstrap, so concurrent callers share one refresh.
 *
 * React StrictMode mounts an effect twice in development, and two concurrent
 * refreshes rotate the refresh token twice: the loser gets a 401 and the officer
 * lands back on the login form on every reload.
 */
let bootstrapping: Promise<void> | undefined;

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

  async changePassword(password) {
    const result = await api.POST("/v1/auth/change-password", { body: { password } });
    const token = (result.data as { token?: string } | undefined)?.token;
    if (!result.response.ok || typeof token !== "string" || token === "") {
      throw new ApiError({
        status: result.response.status,
        code: result.response.status === 422 ? "unprocessable_entity" : "error",
        message: issueMessage(result.error) ?? "That password was not accepted.",
      });
    }
    setFieldToken(token);
    const user = get().user;
    if (user !== undefined) set({ user: { ...user, mustChangeCredentials: false } });
    // The tenant config was refused while the account was flagged; load it now so
    // the officer's first screen is branded rather than the neutral default.
    try {
      const config = await fetchConfig();
      if (config !== undefined) {
        applyTheme(config);
        set({ config, configError: false });
      }
    } catch {
      // A shift can start without branding.
    }
  },

  async refresh() {
    try {
      const refreshed = await api.POST("/v1/auth/refresh", { credentials: apiCredentials });
      const token = refreshed.data?.token;
      if (typeof token !== "string" || token === "") return false;
      setFieldToken(token);
      return true;
    } catch {
      return false;
    }
  },

  async logout() {
    try {
      await api.POST("/v1/auth/logout", { credentials: apiCredentials });
    } catch {
      // The local session is cleared regardless; the token expires on its own.
    }
    setFieldToken(undefined);
    set({ status: "anonymous", user: undefined });
  },

  async initialize() {
    if (get().status !== "unknown") return;
    if (bootstrapping !== undefined) {
      await bootstrapping;
      return;
    }
    bootstrapping = (async () => {
      const cached = readCachedConfig();
      if (cached !== undefined) applyTheme(cached);
      try {
        const refreshed = await api.POST("/v1/auth/refresh", { credentials: apiCredentials });
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
    })();
    try {
      await bootstrapping;
    } finally {
      bootstrapping = undefined;
    }
  },

  hasPermission(permission) {
    return get().user?.permissions.includes(permission) ?? false;
  },
}));

/** The first field issue the server reported, as one sentence for the screen. */
function issueMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (typeof issue !== "object" || issue === null) continue;
      const message = (issue as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

async function loadMe(): Promise<FieldUser | undefined> {
  const me = await api.GET("/v1/auth/me");
  const body = me.data as MeResponse | undefined;
  if (body?.userId === undefined || body.tenantId === undefined) return undefined;
  return {
    userId: body.userId,
    tenantId: body.tenantId,
    displayName: body.displayName ?? "Officer",
    permissions: body.permissions ?? [],
    mustChangeCredentials: body.mustChangeCredentials === true,
  };
}
