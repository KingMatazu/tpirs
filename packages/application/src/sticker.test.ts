import { describe, expect, it } from "vitest";
import {
  parseStickerDimensions,
  qrViewBox,
  renderAssetSticker,
  stickerQrPayload,
} from "./sticker.js";

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

/** A token of the shape the registry actually issues: 32 hex + 16 base32. */
const realToken = `${"4f1c9a2b7d3e5f60718293a4b5c6d7e8"}.${"KJ2XWQ7M4TZB3RPA"}`;

/** Reads the nested QR wrapper the sticker draws: position, size and viewBox. */
function qrWrapper(svg: string): {
  x: number;
  y: number;
  size: number;
  modules: number;
} | null {
  const match =
    /<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/u.exec(
      svg,
    );
  if (match === null) return null;
  return {
    x: Number(match[1]),
    y: Number(match[2]),
    size: Number(match[3]),
    modules: Number(match[5]),
  };
}

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

// The QR used to be drawn at one unit per millimetre with no viewBox, inside a
// smaller viewport: 20% of the code was clipped off the print and no scanner
// could read it. These tests pin the geometry, not the exact artwork.
describe("sticker QR geometry", () => {
  it("scales the QR into its printed box with a viewBox", async () => {
    const svg = await renderAssetSticker({ ...baseInput, qrToken: realToken });
    const wrapper = qrWrapper(svg);
    expect(wrapper).not.toBeNull();
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    // A 49-character token is 33 modules plus two modules of quiet zone.
    expect(wrapper?.modules).toBe(37);
    expect(wrapper?.size).toBeGreaterThanOrEqual(34);
  });

  it("leaves at least 0.9 mm per module, which is what a phone camera needs", async () => {
    const svg = await renderAssetSticker({ ...baseInput, qrToken: realToken });
    const wrapper = qrWrapper(svg);
    expect(wrapper).not.toBeNull();
    const plannedSize = wrapper?.size ?? 0;
    const modules = wrapper?.modules ?? 1;
    expect(plannedSize / modules).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the QR clear of the text band at the foot of the card", async () => {
    const svg = await renderAssetSticker({ ...baseInput, qrToken: realToken });
    const wrapper = qrWrapper(svg);
    expect(wrapper).not.toBeNull();
    expect((wrapper?.y ?? 0) + (wrapper?.size ?? 0)).toBeLessThanOrEqual(51);
  });

  it("renders a QR that fits a smaller 80x50 mm sticker without overprinting", async () => {
    const svg = await renderAssetSticker({ ...baseInput, stickerSpec: "80x50mm" });
    const wrapper = qrWrapper(svg);
    expect(wrapper).not.toBeNull();
    expect((wrapper?.y ?? 0) + (wrapper?.size ?? 0)).toBeLessThanOrEqual(50);
  });
});

describe("qrViewBox", () => {
  it("reads the viewBox the QR library declares", () => {
    expect(qrViewBox('<svg viewBox="0 0 21 21"><path/></svg>')).toBe("0 0 21 21");
  });

  it("falls back to the size stated by the background path", () => {
    expect(qrViewBox('<svg><path d="M0 0h37v37H0z"/></svg>')).toBe("0 0 37 37");
  });

  it("reports nothing when the output carries no size at all", () => {
    expect(qrViewBox("<svg></svg>")).toBeUndefined();
  });
});

// Both payload shapes scan into the same token, so stickers printed under either
// deployment setting keep working (ADR 0067).
describe("stickerQrPayload", () => {
  it("carries the bare opaque token when no verification page is configured", () => {
    expect(stickerQrPayload("abc.def")).toBe("abc.def");
    expect(stickerQrPayload("abc.def", "")).toBe("abc.def");
    expect(stickerQrPayload("abc.def", "   ")).toBe("abc.def");
  });

  it("wraps the token in the verification URL when one is configured", () => {
    expect(stickerQrPayload("abc.def", "https://levy.example.gov")).toBe(
      "https://levy.example.gov/v/abc.def",
    );
    expect(stickerQrPayload("abc.def", "https://levy.example.gov/")).toBe(
      "https://levy.example.gov/v/abc.def",
    );
  });

  it("encodes a longer code when the URL form is used", async () => {
    const bare = await renderAssetSticker({ ...baseInput, qrToken: realToken });
    const url = await renderAssetSticker({
      ...baseInput,
      qrToken: realToken,
      verifyBaseUrl: "https://levy.example.gov",
    });
    expect(qrWrapper(url)?.modules ?? 0).toBeGreaterThan(qrWrapper(bare)?.modules ?? 0);
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
