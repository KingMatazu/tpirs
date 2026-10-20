import { DomainError } from "./errors.js";
import { qrPayload } from "./asset.js";
import type { QrPayload } from "./asset.js";

/**
 * Computes and checks the checksum portion of a QR token. Implemented with
 * HMAC-SHA256 in @tpirs/crypto; kept as a port so domain stays pure and the
 * key never enters domain code (build brief section 6).
 */
export interface QrTokenSigner {
  /** Returns the checksum for a payload (URL-safe, deterministic). */
  checksum(payload: string): string;
  /** Constant-time comparison of a presented checksum. */
  verify(payload: string, checksum: string): boolean;
}

export class InvalidQrTokenError extends DomainError {}

const TOKEN_SEPARATOR = ".";
const CHECKSUM_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** Builds `<payload>.<checksum>` from an opaque payload and a signer. */
export function buildQrToken(payload: string, signer: QrTokenSigner): string {
  const valid = qrPayload(payload);
  const checksum = signer.checksum(valid);
  if (!CHECKSUM_PATTERN.test(checksum)) {
    throw new InvalidQrTokenError("Signer produced a malformed checksum");
  }
  return `${valid}${TOKEN_SEPARATOR}${checksum}`;
}

/**
 * Parses and verifies a QR token, returning the opaque payload. Throws
 * InvalidQrTokenError for a malformed token or a bad checksum, so a forged
 * sticker fails closed and reveals nothing.
 */
export function parseQrToken(token: string, signer: QrTokenSigner): QrPayload {
  const separatorIndex = token.lastIndexOf(TOKEN_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    throw new InvalidQrTokenError("QR token is malformed");
  }
  const payloadPart = token.slice(0, separatorIndex);
  const checksumPart = token.slice(separatorIndex + 1);
  let payload: QrPayload;
  try {
    payload = qrPayload(payloadPart);
  } catch (error) {
    throw new InvalidQrTokenError("QR token payload is malformed", { cause: error });
  }
  if (!CHECKSUM_PATTERN.test(checksumPart)) {
    throw new InvalidQrTokenError("QR token checksum is malformed");
  }
  if (!signer.verify(payload, checksumPart)) {
    throw new InvalidQrTokenError("QR token checksum does not match");
  }
  return payload;
}

/**
 * Renders a tenant-configured token format (e.g. `QR-{id}`) by substituting the
 * token for `{id}`. The template comes from tenant config, never from code.
 */
export function formatStickerCode(template: string, token: string): string {
  if (!template.includes("{id}")) {
    throw new InvalidQrTokenError(`Sticker format "${template}" must contain {id}`);
  }
  return template.replaceAll("{id}", token);
}
