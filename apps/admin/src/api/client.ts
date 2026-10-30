import { createApiClient, refreshOnUnauthorized } from "@tpirs/api-client";

/**
 * The generated typed client for the dashboard. Session wiring is kept out of
 * this module (no imports of the store) so the store can import the client
 * without a cycle: `main.tsx` calls `wireSession` once with the store's token
 * reader and silent-refresh action (D26).
 */
let tokenReader: () => string | undefined = () => undefined;
let refreshAction: () => Promise<void> = () => Promise.resolve();

export function wireSession(wiring: {
  readonly getAccessToken: () => string | undefined;
  readonly refresh: () => Promise<void>;
}): void {
  tokenReader = wiring.getAccessToken;
  refreshAction = wiring.refresh;
}

export const api = createApiClient({
  // Same-origin by default: the page's own origin, so development requests hit
  // Vite's /v1 proxy (apps/admin/vite.config.ts) and production sits behind one
  // origin. A split-origin deployment sets VITE_API_BASE_URL.
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? window.location.origin,
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "dashboard",
});

api.use(
  refreshOnUnauthorized({
    refresh: () => refreshAction(),
    getAccessToken: () => tokenReader(),
  }),
);
