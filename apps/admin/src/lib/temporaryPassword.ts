/**
 * A temporary password an administrator can read out loud.
 *
 * Thirty-two characters, chosen so there is no modulo bias when a random byte is
 * masked: lowercase without `l` and `o`, digits without `0` and `1`. The point is
 * not entropy for its own sake — it is that a handover stops defaulting to
 * `password1`, which is what a typed field produces under time pressure.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export const TEMPORARY_PASSWORD_LENGTH = 16;

export function temporaryPassword(length: number = TEMPORARY_PASSWORD_LENGTH): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  const characters: string[] = [];
  for (const byte of bytes) characters.push(ALPHABET.charAt(byte & 31));
  return characters.join("");
}
