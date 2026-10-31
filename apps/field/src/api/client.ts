import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setFieldToken(token: string | undefined): void {
  tokenReader = () => token;
}

/**
 * Same-origin client. `credentials: "same-origin"` is what lets the browser
 * store the httpOnly refresh cookie (ADR 0026): with `omit`, the response's
 * `Set-Cookie` is discarded and every reload signs the officer out.
 *
 * `idempotencyKeyPrefix` namespaces the keys this app generates so a scan queued
 * on a handset can never collide with a dashboard request.
 */
export const api = createApiClient({
  baseUrl: "",
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "field",
});
