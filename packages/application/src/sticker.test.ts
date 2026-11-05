import { describe, expect, it } from "vitest";
import { parseStickerDimensions, renderAssetSticker } from "./sticker.js";

const baseInput = {
  qrToken: "TMP.abc123",
  shortCode: "B42",
  appName: "Example Levy",
  primaryColor: "#0a5a4a",
  secondaryColor: "#053b33",
  accentColor: "#f2c200",
  assetTypeLabel: "Motorbike",
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
    expect(svg).toContain("Motorbike");
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

describe("sticker logo", () => {
  it("inlines an uploaded logo beside the app name", async () => {
    const logo = `data:image/png;base64,${"A".repeat(32)}`;
    const svg = await renderAssetSticker({ ...baseInput, logoUrl: logo });
    expect(svg).toContain('<image x="1.5"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain(`href="${logo}"`);
    // The title moves out of the logo's way.
    expect(svg).toContain('text-anchor="start"');
  });

  it("never fetches a hosted logo: that sticker prints the text header", async () => {
    const svg = await renderAssetSticker({
      ...baseInput,
      logoUrl: "https://cdn.example.gov/logo.svg",
    });
    expect(svg).not.toContain("<image");
    expect(svg).toContain('text-anchor="middle"');
  });

  it("prints the text header when there is no logo at all", async () => {
    const svg = await renderAssetSticker({ ...baseInput, logoUrl: "" });
    expect(svg).not.toContain("<image");
    expect(svg).toContain("Example Levy");
  });
});
