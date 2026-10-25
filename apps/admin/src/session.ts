import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";
import { api } from "./api/client.js";
import { unwrap, errorFrom, type ApiResult } from "./api/unwrap.js";

export interface StaffUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export type SessionStatus = "unknown" | "anonymous" | "authenticated";

export interface LoginInput {
  readonly tenantSlug: string;
  readonly username: string;
  readonly password: string;
  readonly totpCode?: string;
}

interface SessionState {
  readonly status: SessionStatus;
  readonly accessToken: string | undefined;
  readonly user: StaffUser | undefined;
  readonly initializing: boolean;
  login(input: LoginInput): Promise<void>;
  silentRefresh(): Promise<void>;
  initialize(): Promise<void>;
  logout(): Promise<void>;
  /** True when the signed-in user holds the permission. */
  hasPermission(permission: string): boolean;
}

interface LoginResponse {
  readonly token?: string;
  readonly user?: {
    readonly userId?: string;
    readonly tenantId?: string;
    readonly displayName?: string;
    readonly roles?: readonly string[];
  };
}

interface MeResponse {
  readonly userId?: string;
  readonly tenantId?: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
}

/**
 * In-memory bearer session (ADR 0026): the access token lives in store state
 * only — never localStorage, never a URL — and the browser holds the rotating
 * refresh token in an httpOnly cookie scoped to /v1/auth/refresh. Replay-on-401
 * for GETs is handled by the refreshOnUnauthorized middleware.
 */
export const useSession = create<SessionState>()((set, get) => ({
  status: "unknown",
  accessToken: undefined,
  user: undefined,
  initializing: false,

  async login(input) {
    const result = await api.POST("/v1/auth/login", {
      body: {
        tenantSlug: input.tenantSlug,
        username: input.username,
        password: input.password,
        ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
      },
    });
    const token = unwrapLogin(result);
    set({
      status: "authenticated",
      accessToken: token,
      user: undefined,
    });
    // Login's body carries display basics only; permissions come from /me.
    const applied = await applyMe(set);
    if (!applied) {
      set({ status: "anonymous", accessToken: undefined, user: undefined });
      throw new ApiError({
        status: 401,
        code: "unauthorized",
        message: "Signed in but the session details could not be loaded",
      });
    }
  },

  async silentRefresh() {
    try {
      const result = await api.POST("/v1/auth/refresh", {
        credentials: "same-origin",
      });
      const data = unwrap(result);
      const token = (data as { token?: string }).token;
      if (typeof token !== "string" || token === "") {
        set({ status: "anonymous", accessToken: undefined, user: undefined });
        return;
      }
      set({ status: "authenticated", accessToken: token, user: undefined });
      await applyMe(set);
    } catch {
      set({ status: "anonymous", accessToken: undefined, user: undefined });
    }
  },

  async initialize() {
    if (get().status !== "unknown") return;
    set({ initializing: true });
    await get().silentRefresh();
    set({ initializing: false });
  },

  async logout() {
    try {
      await api.POST("/v1/auth/logout", {
        credentials: "same-origin",
      });
    } catch {
      // The local session is cleared regardless; a failed server-side revoke is
      // retried by the token's own expiry.
    }
    set({ status: "anonymous", accessToken: undefined, user: undefined });
  },

  hasPermission(permission) {
    const user = get().user;
    if (user === undefined) return false;
    return user.permissions.includes(permission);
  },
}));

function unwrapLogin(result: ApiResult<LoginResponse>): string {
  if (result.error !== undefined && result.error !== null) {
    throw errorFrom(result);
  }
  const token = result.data?.token;
  if (typeof token !== "string" || token === "") {
    throw new ApiError({
      status: 500,
      code: "error",
      message: "Login response did not contain an access token",
    });
  }
  return token;
}

async function applyMe(set: (partial: Partial<SessionState>) => void): Promise<string | undefined> {
  try {
    const me = await unwrap<MeResponse>(api.GET("/v1/auth/me"));
    if (
      typeof me.userId !== "string" ||
      typeof me.tenantId !== "string" ||
      typeof me.displayName !== "string"
    ) {
      return undefined;
    }
    const roles = me.roles ?? [];
    const permissions = me.permissions ?? [];
    set({
      user: {
        userId: me.userId,
        tenantId: me.tenantId,
        displayName: me.displayName,
        roles: roles,
        permissions: permissions,
      },
    });
    return me.displayName;
  } catch {
    return undefined;
  }
}
