import { toString as qrToSvg } from "qrcode";

export interface StickerInput {
  readonly qrToken: string;
  /**
   * When set, the QR encodes `<base>/v/<token>` instead of the bare token, so a
   * civilian's phone camera opens a page rather than showing an opaque string.
   * The officer app strips the URL and uses the token either way (ADR 0067).
   */
  readonly verifyBaseUrl?: string;
  readonly shortCode: string;
  readonly appName: string;
  /**
   * The state's logo, when it is an upload (`data:image/…`). A hosted https logo
   * is not fetched at render time: the API must not make outbound requests on a
   * sticker download, so those stickers print the text header alone.
   */
  readonly logoUrl?: string;
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
  readonly assetTypeLabel: string;
  readonly stickerSpec: string;
}

export interface StickerDimensions {
  readonly widthMm: number;
  readonly heightMm: number;
}

const DEFAULT_DIMENSIONS: StickerDimensions = { widthMm: 60, heightMm: 60 };

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Parses dimensions out of a free-form sticker spec such as
 * "60x60mm vinyl, weatherproof". Unparseable or non-positive specs fall back
 * to the default size, so a tenant wording change never breaks printing.
 */
export function parseStickerDimensions(spec: string): StickerDimensions {
  const match = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*mm/i.exec(spec);
  if (match === null) return DEFAULT_DIMENSIONS;
  const widthMm = Number(match[1]);
  const heightMm = Number(match[2]);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    return DEFAULT_DIMENSIONS;
  }
  return { widthMm, heightMm };
}

/**
 * The string inside the QR code.
 *
 * Two shapes are supported and both scan into the same token: the bare opaque
 * token (default, reveals nothing and needs no public site), or a URL ending in
 * `/v/<token>` once a public verification page exists. The officer app and the
 * verify endpoint accept both, so stickers printed under either setting keep
 * working (ADR 0067).
 */
export function stickerQrPayload(qrToken: string, verifyBaseUrl?: string): string {
  const base = (verifyBaseUrl ?? "").trim().replace(/\/+$/u, "");
  return base === "" ? qrToken : `${base}/v/${qrToken}`;
}

/**
 * The coordinate system of the QR the `qrcode` library just produced.
 *
 * The rendered `<path>` elements are in module units (`0..modules`), so the
 * wrapper has to carry this viewBox or the code is drawn at one unit per
 * millimetre and silently clipped (the bug behind broken scans, ADR 0067).
 */
export function qrViewBox(renderedSvg: string): string | undefined {
  const declared = /viewBox="([^"]+)"/u.exec(renderedSvg)?.[1];
  if (declared !== undefined) return declared;
  // Older/newer library output without a viewBox still states its size in the
  // background path, e.g. `d="M0 0h37v37H0z"`.
  const background = /d="M0 0h(\d+(?:\.\d+)?)v(\d+(?:\.\d+)?)H0z"/u.exec(renderedSvg);
  const width = background?.[1];
  const height = background?.[2];
  return width === undefined || height === undefined ? undefined : `0 0 ${width} ${height}`;
}

/**
 * Renders a printable SVG sticker: tenant branding header, the QR (encoding the
 * token or its verification URL), the human short code for manual lookup, and
 * the asset-type label. All branding and sizing values come from tenant config;
 * this module hardcodes nothing tenant-specific.
 */
export async function renderAssetSticker(input: StickerInput): Promise<string> {
  const { widthMm, heightMm } = parseStickerDimensions(input.stickerSpec);
  const rawQr = await qrToSvg(stickerQrPayload(input.qrToken, input.verifyBaseUrl), {
    type: "svg",
    // Two modules of quiet zone, not one: stickers get dirty, and a scanner
    // needs quiet space around the code more than it needs the extra millimetre.
    margin: 2,
    errorCorrectionLevel: "M",
  });
  const viewBox = qrViewBox(rawQr);
  const qrBody = rawQr
    .replace(/^<\?xml[^>]*>\s*/u, "")
    .replace(/^<svg[^>]*>/u, "")
    .replace(/<\/svg>\s*$/u, "");

  const headerHeight = Math.min(9, heightMm * 0.16);
  const footerHeight = Math.min(7, heightMm * 0.12);
  // The QR takes every millimetre the header, the text band and the card edges
  // leave over: a 49-character token needs 35 modules, and below roughly 0.8 mm
  // per module a phone camera in sunlight starts to struggle.
  const qrSize = Math.max(10, Math.min(widthMm - 8, heightMm - headerHeight - footerHeight - 9));
  const qrX = (widthMm - qrSize) / 2;
  const qrY = headerHeight + 3;
  const codeY = qrY + qrSize + 5.3;
  const typeY = codeY + 3.3;
  const footerY = heightMm - 1.4;
  const codeFontSize = Math.max(3.5, Math.min(widthMm * 0.08, qrSize * 0.15));
  const typeFontSize = Math.max(2.2, Math.min(widthMm * 0.045, qrSize * 0.085));

  // Only an uploaded logo can be inlined: an https URL would make the API fetch
  // an external host on every sticker download, and an SVG viewer may refuse it
  // anyway. The header falls back to the app name alone.
  const logo = input.logoUrl?.startsWith("data:image/") === true ? input.logoUrl : undefined;
  const logoSize = Math.max(0, headerHeight - 2);
  const logoX = 1.5;
  const logoY = (headerHeight - logoSize) / 2;
  const titleSize = Math.max(3, headerHeight * 0.55);
  const titleX = logo === undefined ? widthMm / 2 : logoX + logoSize + 2;
  const titleAnchor = logo === undefined ? "middle" : "start";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
    `<rect width="${widthMm}" height="${heightMm}" fill="#ffffff" stroke="${escapeXml(input.secondaryColor)}" stroke-width="0.5"/>`,
    `<rect width="${widthMm}" height="${headerHeight}" fill="${escapeXml(input.primaryColor)}"/>`,
    ...(logo === undefined
      ? []
      : [
          `<image x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(logo)}"/>`,
        ]),
    `<text x="${titleX}" y="${headerHeight / 2 + 1.6}" text-anchor="${titleAnchor}" font-family="sans-serif" font-size="${titleSize}" font-weight="bold" fill="#ffffff">${escapeXml(input.appName)}</text>`,
    `<rect x="${qrX - 1}" y="${qrY - 1}" width="${qrSize + 2}" height="${qrSize + 2}" fill="#ffffff" stroke="${escapeXml(input.accentColor)}" stroke-width="0.8"/>`,
    // `viewBox` and `preserveAspectRatio` are what scale the module units onto
    // the printed box. Without them the paths draw at 1 mm per module and are
    // clipped by the nested viewport, which produces an unscannable sticker.
    `<svg x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}"${viewBox === undefined ? "" : ` viewBox="${viewBox}"`} preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">${qrBody}</svg>`,
    `<text x="${widthMm / 2}" y="${codeY}" text-anchor="middle" font-family="sans-serif" font-size="${codeFontSize}" font-weight="bold" fill="${escapeXml(input.primaryColor)}">${escapeXml(input.shortCode)}</text>`,
    `<text x="${widthMm / 2}" y="${typeY}" text-anchor="middle" font-family="sans-serif" font-size="${typeFontSize}" fill="${escapeXml(input.secondaryColor)}">${escapeXml(input.assetTypeLabel)}</text>`,
    // "Scan to verify" is dropped rather than overprinted when the card is too
    // short to give it its own line (an 80x50 mm sticker, for example).
    ...(footerY - typeY < 2.6
      ? []
      : [
          `<text x="${widthMm / 2}" y="${footerY}" text-anchor="middle" font-family="sans-serif" font-size="2.2" fill="#666666">Scan to verify</text>`,
        ]),
    `</svg>`,
  ].join("");
}
