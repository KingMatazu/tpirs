import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";
import { api, setCollectorToken } from "./api/client.js";

export interface CollectorUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
}

export type SessionStatus = "unknown" | "anonymous" | "authenticated";

interface SessionState {
  readonly status: SessionStatus;
  readonly user: CollectorUser | undefined;
  login(input: { tenantSlug: string; username: string; password: string }): Promise<void>;
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
 * The collector's session: a short-lived bearer in memory and the D26 refresh
 * cookie in the browser. Nothing is persisted to localStorage — a shared handset
 * must not keep a session after the app is closed.
 */
export const useSession = create<SessionState>()((set, get) => ({
  status: "unknown",
  user: undefined,

  async login(input) {
    const result = await api.POST("/v1/auth/login", { body: input });
    if (!result.response.ok) {
      throw new ApiError({
        status: result.response.status,
        code: "unauthorized",
        message: "Those details were not accepted.",
      });
    }
    const token = result.data?.token;
    if (typeof token !== "string" || token === "") {
      throw new ApiError({ status: 500, code: "error", message: "Sign-in returned no token" });
    }
    setCollectorToken(token);
    const user = await loadMe();
    if (user === undefined) {
      setCollectorToken(undefined);
      throw new ApiError({
        status: 401,
        code: "unauthorized",
        message: "Signed in, but the session details could not be loaded",
      });
    }
    set({ status: "authenticated", user });
  },

  async logout() {
    try {
      await api.POST("/v1/auth/logout", { credentials: "same-origin" });
    } catch {
      // The local session is cleared regardless; the token expires on its own.
    }
    setCollectorToken(undefined);
    set({ status: "anonymous", user: undefined });
  },

  async initialize() {
    if (get().status !== "unknown") return;
    try {
      const refreshed = await api.POST("/v1/auth/refresh", { credentials: "same-origin" });
      const token = refreshed.data?.token;
      if (typeof token !== "string" || token === "") {
        set({ status: "anonymous" });
        return;
      }
      setCollectorToken(token);
      const user = await loadMe();
      if (user === undefined) {
        setCollectorToken(undefined);
        set({ status: "anonymous" });
        return;
      }
      set({ status: "authenticated", user });
    } catch {
      set({ status: "anonymous" });
    }
  },

  hasPermission(permission) {
    return get().user?.permissions.includes(permission) ?? false;
  },
}));

async function loadMe(): Promise<CollectorUser | undefined> {
  const me = await api.GET("/v1/auth/me");
  const body = me.data as MeResponse | undefined;
  if (body?.userId === undefined || body.tenantId === undefined) return undefined;
  return {
    userId: body.userId,
    tenantId: body.tenantId,
    displayName: body.displayName ?? "Collector",
    permissions: body.permissions ?? [],
  };
}
