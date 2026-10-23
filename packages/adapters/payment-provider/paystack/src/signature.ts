import { createHmac, timingSafeEqual } from "node:crypto";

export const PAYSTACK_WEBHOOK_SECRET = "paystack-test-secret";

export function paystackWebhookSignature(
  rawBody: string,
  secret = PAYSTACK_WEBHOOK_SECRET,
): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyPaystackSignature(
  rawBody: string,
  signature: string | string[] | undefined,
  secret = PAYSTACK_WEBHOOK_SECRET,
): boolean {
  const provided = Array.isArray(signature) ? signature[0] : signature;
  if (typeof provided !== "string") {
    return false;
  }
  const expected = paystackWebhookSignature(rawBody, secret);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  try {
    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
