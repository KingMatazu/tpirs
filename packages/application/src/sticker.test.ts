import { describe, expect, it } from "vitest";
import { parseStickerDimensions, renderAssetSticker } from "./sticker.js";

const baseInput = {
  qrToken: "TMP.abc123",
  shortCode: "B42",
  appName: "Example Levy",
  primaryColor: "#0a5a4a",
  secondaryColor: "#053b33",
  accentColor: "#f2c200",
  assetTypeLabel: "Bicycle",
  stickerSpec: "60x60mm vinyl, weatherproof",
};

describe("parseStickerDimensions", () => {
  it("parses width and height from a free-form spec", () => {
    expect(parseStickerDimensions("60x60mm vinyl, weatherproof")).toEqual({
      widthMm: 60,
      heightMm: 60,
    });
  });

  it("falls back to the default size when no dimensions are present", () => {
    expect(parseStickerDimensions("weatherproof vinyl")).toEqual({
      widthMm: 60,
      heightMm: 60,
    });
  });

  it("rejects non-positive dimensions and falls back", () => {
    expect(parseStickerDimensions("0x60mm")).toEqual({ widthMm: 60, heightMm: 60 });
  });
});

describe("renderAssetSticker", () => {
  it("renders an SVG sticker carrying branding, short code, and QR payload", async () => {
    const svg = await renderAssetSticker(baseInput);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="60mm"');
    expect(svg).toContain("Example Levy");
    expect(svg).toContain("B42");
    expect(svg).toContain("Bicycle");
    expect(svg).toContain("#0a5a4a");
  });

  it("escapes tenant-provided text so markup in branding cannot break the SVG", async () => {
    const svg = await renderAssetSticker({
      ...baseInput,
      appName: 'Levy & <Taxes> "One"',
    });
    expect(svg).toContain("Levy &amp; &lt;Taxes&gt; &quot;One&quot;");
    expect(svg).not.toContain("<Taxes>");
  });

  it("honours non-default sticker dimensions", async () => {
    const svg = await renderAssetSticker({
      ...baseInput,
      stickerSpec: "80x50mm",
    });
    expect(svg).toContain('width="80mm"');
    expect(svg).toContain('height="50mm"');
    expect(svg).toContain('viewBox="0 0 80 50"');
  });
});
