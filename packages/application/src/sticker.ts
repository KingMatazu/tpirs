import { toString as qrToSvg } from "qrcode";

export interface StickerInput {
  readonly qrToken: string;
  readonly shortCode: string;
  readonly appName: string;
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
 * Renders a printable SVG sticker: tenant branding header, the QR token
 * (encoding the full opaque token, which is what officers scan), the human
 * short code for manual lookup, and the asset-type label. All branding and
 * sizing values come from tenant config; this module hardcodes nothing
 * tenant-specific.
 */
export async function renderAssetSticker(input: StickerInput): Promise<string> {
  const { widthMm, heightMm } = parseStickerDimensions(input.stickerSpec);
  const rawQr = await qrToSvg(input.qrToken, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
  });
  const qrBody = rawQr
    .replace(/^<\?xml[^>]*>\s*/u, "")
    .replace(/^<svg/u, '<svg aria-hidden="true"');

  const headerHeight = Math.min(10, heightMm * 0.18);
  const footerHeight = Math.min(8, heightMm * 0.14);
  const qrSize = Math.min(widthMm - 8, heightMm - headerHeight - footerHeight - 14);
  const qrX = (widthMm - qrSize) / 2;
  const qrY = headerHeight + 3;
  const codeY = qrY + qrSize + 6;
  const footerY = heightMm - 2;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
    `<rect width="${widthMm}" height="${heightMm}" fill="#ffffff" stroke="${escapeXml(input.secondaryColor)}" stroke-width="0.5"/>`,
    `<rect width="${widthMm}" height="${headerHeight}" fill="${escapeXml(input.primaryColor)}"/>`,
    `<text x="${widthMm / 2}" y="${headerHeight / 2 + 1.6}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(3, headerHeight * 0.55)}" font-weight="bold" fill="#ffffff">${escapeXml(input.appName)}</text>`,
    `<rect x="${qrX - 1}" y="${qrY - 1}" width="${qrSize + 2}" height="${qrSize + 2}" fill="#ffffff" stroke="${escapeXml(input.accentColor)}" stroke-width="0.8"/>`,
    `<svg x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}">${qrBody.replace(/^<svg[^>]*>/u, "").replace(/<\/svg>\s*$/u, "")}</svg>`,
    `<text x="${widthMm / 2}" y="${codeY}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(3.5, widthMm * 0.09)}" font-weight="bold" fill="${escapeXml(input.primaryColor)}">${escapeXml(input.shortCode)}</text>`,
    `<text x="${widthMm / 2}" y="${codeY + 4.5}" text-anchor="middle" font-family="sans-serif" font-size="${Math.max(2.5, widthMm * 0.055)}" fill="${escapeXml(input.secondaryColor)}">${escapeXml(input.assetTypeLabel)}</text>`,
    `<text x="${widthMm / 2}" y="${footerY}" text-anchor="middle" font-family="sans-serif" font-size="2.4" fill="#666666">Scan to verify</text>`,
    `</svg>`,
  ].join("");
}
