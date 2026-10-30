import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setCollectorToken(token: string | undefined): void {
  tokenReader = () => token;
}

/**
 * Same-origin client. `same-origin` credentials matter here for the same reason
 * they do in the dashboard: the refresh cookie is httpOnly and only stored when
 * the request that produced it was not `omit` (ADR 0026).
 */
export const api = createApiClient({
  baseUrl: "",
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "collector",
});
