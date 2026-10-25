import { createApiClient } from "@tpirs/api-client";

let tokenReader: () => string | undefined = () => undefined;

export function setFieldToken(token: string | undefined) {
  tokenReader = () => token;
}

export const api = createApiClient({
  baseUrl: "",
  getAccessToken: () => tokenReader(),
  idempotencyKeyPrefix: "field",
});
