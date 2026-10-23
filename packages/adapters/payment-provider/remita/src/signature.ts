import { createHmac, timingSafeEqual } from "node:crypto";

export const REMITA_WEBHOOK_SECRET = "remita-test-secret";

export function remitaWebhookSignature(rawBody: string, secret = REMITA_WEBHOOK_SECRET): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyRemitaSignature(
  rawBody: string,
  signature: string | string[] | undefined,
  secret = REMITA_WEBHOOK_SECRET,
): boolean {
  const provided = Array.isArray(signature) ? signature[0] : signature;
  if (typeof provided !== "string") {
    return false;
  }
  const expected = remitaWebhookSignature(rawBody, secret);
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
