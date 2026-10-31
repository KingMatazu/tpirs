/**
 * Evidence photos for a dispute.
 *
 * An officer's phone takes 4–8 MB pictures; the API accepts 1 MB of JSON and the
 * evidence travels as base64 inside it, so a photo has to be downscaled before it
 * leaves the camera roll. Two attempts (1024 px, then 800 px) cover the ordinary
 * case, and a photo that still does not fit is dropped with a warning rather than
 * blocking the dispute: the officer's account of what happened matters more than
 * the picture.
 */

/** Base64 payload budget: comfortably inside the 1 MB body limit with the JSON around it. */
export const MAX_EVIDENCE_BASE64 = 600_000;

export interface Evidence {
  readonly contentType: string;
  readonly contentBase64: string;
}

/** Strips the `data:image/jpeg;base64,` prefix a canvas produces. */
export function base64Of(dataUrl: string): string | undefined {
  const marker = ";base64,";
  const index = dataUrl.indexOf(marker);
  if (index === -1) return undefined;
  return dataUrl.slice(index + marker.length);
}

/** True when the encoded photo fits the request budget. */
export function fitsBudget(base64: string): boolean {
  return base64.length > 0 && base64.length <= MAX_EVIDENCE_BASE64;
}

export async function prepareEvidence(file: Blob): Promise<Evidence | undefined> {
  for (const [maxPixels, quality] of [
    [1024, 0.6],
    [800, 0.5],
  ] as const) {
    const dataUrl = await downscale(file, maxPixels, quality);
    if (dataUrl === undefined) return undefined;
    const contentBase64 = base64Of(dataUrl);
    if (contentBase64 !== undefined && fitsBudget(contentBase64)) {
      return { contentType: "image/jpeg", contentBase64 };
    }
  }
  return undefined;
}

async function downscale(
  file: Blob,
  maxPixels: number,
  quality: number,
): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxPixels / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    // A format the browser cannot decode (HEIC on some devices) is not worth
    // failing a dispute over.
    return undefined;
  }
}
