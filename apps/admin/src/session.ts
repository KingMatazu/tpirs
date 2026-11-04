import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";
import { api, apiCredentials } from "./api/client.js";
import { unwrap, errorFrom, type ApiResult } from "./api/unwrap.js";

export interface StaffUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  /**
   * The zone a supervisor is responsible for. Null for every other role; the
   * driver form locks to it rather than offering a choice the server refuses.
   */
  readonly zoneId?: string | null;
  /**
   * True while the account still holds the credentials it was provisioned with.
   * The server refuses every route except the completion one until it is false;
   * the client mirrors that by sending such an account to the credential screen.
   */
  readonly mustChangeCredentials?: boolean;
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
  /**
   * Whether this deployment still needs its first tenant. Undefined until
   * `initialize` has asked the server; a configured deployment reports false,
   * and an unreachable one is treated as false so the sign-in screen (and its
   * error) shows rather than a setup wizard that cannot run.
   */
  readonly needsSetup: boolean | undefined;
  login(input: LoginInput): Promise<void>;
  silentRefresh(): Promise<void>;
  initialize(): Promise<void>;
  /** Asks `GET /v1/setup/status` and records whether onboarding is needed. */
  checkSetup(): Promise<void>;
  /**
   * Installs an already-obtained access token and loads the account behind it.
   * `login` uses this after the sign-in call; the credential step uses it after
   * `complete-onboarding` returns a fresh session.
   */
  acceptSession(token: string): Promise<void>;
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
  readonly mustChangeCredentials?: boolean;
}

/**
 * In-memory bearer session (ADR 0026): the access token lives in store state
 * only — never localStorage, never a URL — and the browser holds the rotating
 * refresh token in an httpOnly cookie scoped to /v1/auth/refresh. Replay-on-401
 * for GETs is handled by the refreshOnUnauthorized middleware.
 */
/**
 * The in-flight refresh, shared by every caller.
 *
 * Refresh tokens rotate, so two refreshes at once (React StrictMode mounting an
 * effect twice, or the 401 middleware racing the boot) means the loser gets a 401
 * and the user is signed out on the next load. One promise, one rotation.
 */
let refreshing: Promise<void> | undefined;

export const useSession = create<SessionState>()((set, get) => ({
  status: "unknown",
  accessToken: undefined,
  user: undefined,
  initializing: false,
  needsSetup: undefined,

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
    await get().acceptSession(token);
  },

  async acceptSession(token) {
    set({
      status: "authenticated",
      accessToken: token,
      user: undefined,
    });
    // The session body carries display basics only; permissions (and the
    // must-change-credentials flag) come from /me.
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
    if (refreshing !== undefined) {
      await refreshing;
      return;
    }
    refreshing = (async () => {
      try {
        const result = await api.POST("/v1/auth/refresh", {
          credentials: apiCredentials,
        });
        const data = await unwrap<{ readonly token?: string }>(result);
        const token = data.token;
        if (typeof token !== "string" || token === "") {
          set({ status: "anonymous", accessToken: undefined, user: undefined });
          return;
        }
        set({ status: "authenticated", accessToken: token, user: undefined });
        await applyMe(set);
      } catch {
        set({ status: "anonymous", accessToken: undefined, user: undefined });
      }
    })();
    try {
      await refreshing;
    } finally {
      refreshing = undefined;
    }
  },

  async initialize() {
    if (get().status !== "unknown") return;
    set({ initializing: true });
    await get().silentRefresh();
    await get().checkSetup();
    set({ initializing: false });
  },

  async checkSetup() {
    try {
      const status = await unwrap<{ readonly needsSetup?: boolean }>(api.GET("/v1/setup/status"));
      set({ needsSetup: status.needsSetup ?? false });
    } catch {
      // See the `needsSetup` doc above: an unreachable deployment is not one
      // that needs onboarding, and showing the wizard would hide the real
      // problem (the API is down).
      set({ needsSetup: false });
    }
  },

  async logout() {
    try {
      await api.POST("/v1/auth/logout", {
        credentials: apiCredentials,
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
        mustChangeCredentials: me.mustChangeCredentials ?? false,
      },
    });
    return me.displayName;
  } catch {
    return undefined;
  }
}
