import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setFieldToken(token: string | undefined): void {
  tokenReader = () => token;
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * `same-origin` by default. A split-origin deployment (API on another site)
 * sets `VITE_API_BASE_URL` and takes `include`, or the refresh cookie is never
 * stored or sent (ADR 0052).
 *
 * `idempotencyKeyPrefix` namespaces the keys this app generates so a scan queued
 * on a handset can never collide with a dashboard request.
 */
export const apiCredentials: "same-origin" | "include" =
  apiBaseUrl === "" ? "same-origin" : "include";

export const api = createApiClient({
  baseUrl: apiBaseUrl,
  credentials: apiCredentials,
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "field",
});
