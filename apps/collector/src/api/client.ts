import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setCollectorToken(token: string | undefined): void {
  tokenReader = () => token;
}

/** The in-memory bearer, for the development-only simulator call. */
export function collectorToken(): string | undefined {
  return tokenReader();
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * An absolute URL for a hand-written request (the dev simulator is outside the
 * generated contract). A relative path would hit the collector's own SPA
 * rewrite on a split-origin deployment and return `index.html` with a 200.
 */
export function apiUrl(path: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * `same-origin` by default. A split-origin deployment sets `VITE_API_BASE_URL`
 * and takes `include`, because the httpOnly refresh cookie is only stored when
 * the request that produced it was not same-origin-suppressed (ADR 0026/0052).
 */
export const apiCredentials: "same-origin" | "include" =
  apiBaseUrl === "" ? "same-origin" : "include";

export const api = createApiClient({
  baseUrl: apiBaseUrl,
  credentials: apiCredentials,
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "collector",
});
