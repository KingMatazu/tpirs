import { createHash } from "node:crypto";

export const MOCK_WEBHOOK_SECRET = "mock-webhook-secret";

export function mockWebhookSignature(rawBody: string, secret = MOCK_WEBHOOK_SECRET): string {
  return createHash("sha256").update(`${secret}:${rawBody}`).digest("hex");
}
