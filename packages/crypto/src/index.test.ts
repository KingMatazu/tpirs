import { describe, expect, it } from "vitest";
import { generateTotpSecret, hashPassword, totpCode, verifyPassword, verifyTotp } from "./index.js";

describe("password hashing", () => {
  it("round-trips a valid password and rejects a wrong one", async () => {
    const hash = await hashPassword("s3cret-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("s3cret-password", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces a different hash each time (salted)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed stored hash", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("totp", () => {
  it("matches RFC 6238 test vectors (SHA1, 8 digits)", () => {
    // Secret "12345678901234567890" in base32 is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(secret, new Date(59 * 1000), { digits: 8 })).toBe("94287082");
    expect(totpCode(secret, new Date(1111111109 * 1000), { digits: 8 })).toBe("07081804");
    expect(totpCode(secret, new Date(1234567890 * 1000), { digits: 8 })).toBe("89005924");
  });

  it("verifies within the skew window and rejects outside it", () => {
    const secret = generateTotpSecret();
    const now = new Date(1234567890 * 1000);
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, new Date(now.getTime() + 30 * 1000))).toBe(true);
    expect(verifyTotp(secret, code, new Date(now.getTime() + 10 * 60 * 1000))).toBe(false);
  });

  it("generates a base32 secret", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
  });
});
