import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Password hashing with scrypt. The stored form is `scrypt$<saltHex>$<hashHex>`
 * so parameters can be changed later without ambiguity.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (saltHex === undefined || hashHex === undefined) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scryptAsync(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
    SCRYPT_PARAMS,
  );
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** SHA-256 hex of a session token; only the hash is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Returns the base32 character for a 5-bit value (always 0..31). */
function base32Char(value: number): string {
  const char = BASE32_ALPHABET[value & 31];
  if (char === undefined) throw new Error("Invalid base32 index");
  return char;
}

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      // Discard consumed high bits so `value` stays within 32 bits.
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP code for a base32 secret (defaults: SHA1, 6 digits, 30s). */
export function totpCode(
  secretBase32: string,
  forTime: Date = new Date(),
  options: { period?: number; digits?: number } = {},
): string {
  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor(forTime.getTime() / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Accepts the current code and one step either side, to tolerate clock skew. */
export function verifyTotp(
  secretBase32: string,
  code: string,
  forTime: Date = new Date(),
  options: { period?: number; digits?: number; window?: number } = {},
): boolean {
  const period = options.period ?? 30;
  const window = options.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = totpCode(
      secretBase32,
      new Date(forTime.getTime() + offset * period * 1000),
      options,
    );
    if (candidate === code) return true;
  }
  return false;
}

/** Generates a new base32 TOTP secret (20 random bytes, RFC recommended length). */
export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Char(value >>> (bits - 5));
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Char(value << (5 - bits));
  return output;
}

/**
 * A QR token signer: HMAC-SHA256 over the opaque payload with a per-tenant key,
 * rendered as a truncated base32 checksum. Structurally satisfies the domain's
 * QrTokenSigner so domain code stays free of crypto imports.
 */
export interface QrTokenSignerImpl {
  checksum(payload: string): string;
  verify(payload: string, checksum: string): boolean;
}

function hmacBase32(key: Buffer, payload: string, bytes: number): string {
  const digest = createHmac("sha256", key).update(payload).digest();
  const truncated = digest.subarray(0, bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of truncated) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Char(value >>> (bits - 5));
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Char(value << (5 - bits));
  return output;
}

/**
 * Creates a signer from a key reference value. Keys come from the
 * SecretsProvider; this function never reads the environment itself.
 */
export function createQrTokenSigner(
  key: string,
  options: { bytes?: number } = {},
): QrTokenSignerImpl {
  const bytes = options.bytes ?? 10;
  const keyBuffer = Buffer.from(key, "utf8");
  return {
    checksum(payload) {
      return hmacBase32(keyBuffer, payload, bytes);
    },
    verify(payload, checksum) {
      const expected = Buffer.from(hmacBase32(keyBuffer, payload, bytes), "utf8");
      const presented = Buffer.from(checksum, "utf8");
      if (expected.length !== presented.length) return false;
      return timingSafeEqual(expected, presented);
    },
  };
}

/** A random opaque, URL-safe public identifier (no tenant/owner information). */
export function randomOpaqueId(): string {
  return randomUUID().replaceAll("-", "");
}

/**
 * A random numeric one-time code with `digits` digits, uniform and
 * constant-time safe to compare via hash. Uses rejection sampling to avoid
 * modulo bias.
 */
export function randomNumericCode(digits = 6): string {
  if (digits < 1 || digits > 10) throw new Error("digits must be between 1 and 10");
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const value = randomBytes(4).readUInt32BE(0);
    if (value < limit) return String(value % max).padStart(digits, "0");
  }
}
