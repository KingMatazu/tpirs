import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setCollectorToken(token: string | undefined): void {
  tokenReader = () => token;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

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
