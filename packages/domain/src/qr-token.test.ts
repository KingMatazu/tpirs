import { describe, expect, it } from "vitest";
import { buildQrToken, formatStickerCode, InvalidQrTokenError, parseQrToken } from "./qr-token.js";
import type { QrTokenSigner } from "./qr-token.js";

/** A deterministic signer for domain tests; the real one is HMAC in @tpirs/crypto. */
function fakeSigner(): QrTokenSigner {
  return {
    checksum: (payload) => `SIG${payload.length}`,
    verify: (payload, checksum) => checksum === `SIG${payload.length}`,
  };
}

describe("buildQrToken and parseQrToken", () => {
  it("round-trips a valid token", () => {
    const token = buildQrToken("abcdef0123456789", fakeSigner());
    expect(token).toBe("abcdef0123456789.SIG16");
    expect(parseQrToken(token, fakeSigner())).toBe("abcdef0123456789");
  });

  it("rejects a forged checksum (fail closed, reveals nothing)", () => {
    expect(() => parseQrToken("abcdef0123456789.WRONGSIG", fakeSigner())).toThrow(
      InvalidQrTokenError,
    );
  });

  it("rejects malformed tokens", () => {
    expect(() => parseQrToken("noseparator", fakeSigner())).toThrow(InvalidQrTokenError);
    expect(() => parseQrToken(".SIG0", fakeSigner())).toThrow(InvalidQrTokenError);
    expect(() => parseQrToken("abcdef0123456789.", fakeSigner())).toThrow(InvalidQrTokenError);
    expect(() => parseQrToken("bad payload here.SIG16", fakeSigner())).toThrow(InvalidQrTokenError);
  });
});

describe("formatStickerCode", () => {
  it("substitutes the token into the tenant-configured format", () => {
    expect(formatStickerCode("QR-{id}", "PAYLOAD.CHK")).toBe("QR-PAYLOAD.CHK");
    expect(formatStickerCode("HZ/{id}/x", "P.C")).toBe("HZ/P.C/x");
  });

  it("rejects a format without the {id} placeholder", () => {
    expect(() => formatStickerCode("QR-static", "P.C")).toThrow(InvalidQrTokenError);
  });
});
