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

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;

/**
 * The absolute URL for a path on the API.
 *
 * The generated client knows the base URL; a hand-rolled `fetch`, an `<img>` or a
 * download link does not. On a split-origin deployment a relative `/v1/...`
 * resolves against the dashboard's own origin, where the SPA rewrite answers
 * `index.html` — which is how a sticker download produced an HTML file the
 * browser refused to parse as SVG (ADR 0052). Every raw request goes through
 * here so there is one place that knows where the API lives.
 */
export function apiUrl(path: string): string {
  return new URL(path, apiBaseUrl).toString();
}

/**
 * `same-origin` for the default single-origin deployment; `include` when the
 * API lives on another site (ADR 0052), because a cross-site request with
 * `same-origin` neither sends nor stores the refresh cookie.
 */
export const apiCredentials: "same-origin" | "include" =
  apiBaseUrl === window.location.origin ? "same-origin" : "include";

export const api = createApiClient({
  // Same-origin by default: the page's own origin, so development requests hit
  // Vite's /v1 proxy (apps/admin/vite.config.ts) and production sits behind one
  // origin. A split-origin deployment sets VITE_API_BASE_URL.
  baseUrl: apiBaseUrl,
  credentials: apiCredentials,
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "dashboard",
});

api.use(
  refreshOnUnauthorized({
    refresh: () => refreshAction(),
    getAccessToken: () => tokenReader(),
  }),
);
