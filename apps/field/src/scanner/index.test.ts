import { describe, expect, it } from "vitest";
import { normaliseToken, scannerSupport } from "./index.js";

describe("normaliseToken", () => {
  it("keeps a bare token untouched", () => {
    const token = "e8ea7b03cfe51a98e87d979606b3a67e.A1b2C3d4";
    expect(normaliseToken(token)).toBe(token);
  });

  it("trims what a scanner adds around the code", () => {
    expect(normaliseToken("  abc.def  ")).toBe("abc.def");
  });

  it("unwraps a token from a sticker URL", () => {
    expect(normaliseToken("https://alpha.example/v/abc.def")).toBe("abc.def");
    expect(normaliseToken("https://alpha.example/v/abc.def?src=sticker")).toBe("abc.def");
  });

  it("does not upper-case the token, because the payload is case-sensitive", () => {
    expect(normaliseToken("AbC.dEf")).toBe("AbC.dEf");
  });

  it("returns nothing for an empty read", () => {
    expect(normaliseToken("   ")).toBe("");
  });
});

describe("scannerSupport", () => {
  it("reports what this environment can do", () => {
    // jsdom has no camera and no BarcodeDetector, so the honest answer is "none";
    // the app then opens on the manual tab instead of asking for a camera that
    // does not exist.
    expect(["native", "jsqr", "none"]).toContain(scannerSupport());
  });
});
