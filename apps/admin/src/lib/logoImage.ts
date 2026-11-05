/**
 * Turning a chosen image into a logo the tenant config can hold.
 *
 * The config stores the logo inline (ADR 0065), so the file has to shrink before
 * it is sent: a phone photo of a letterhead is several megabytes, and the same
 * bytes would be copied into the audit row of every later config change. The
 * browser is the right place to do that — it has the decoder and the canvas.
 */

/** Longest edge, in pixels, of the stored image. A logo never needs more. */
export const LOGO_MAX_EDGE = 512;
/** What the uploader aims for; the server's hard limit is 128 KB. */
export const LOGO_TARGET_BYTES = 96 * 1024;

export const LOGO_ACCEPTED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
];

/** A failure with a message meant for the person choosing the file. */
export class LogoError extends Error {}

export function isAcceptedLogoType(type: string): boolean {
  return LOGO_ACCEPTED_TYPES.includes(type);
}

/**
 * Bytes behind a data URL, near enough for a size cap. Base64 carries three
 * bytes in four characters; the payload's own percent-encoding (SVG data URLs
 * may be URL-encoded) is counted as-is, which over-estimates and so fails safe.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const payload = dataUrl.slice(comma + 1);
  if (!dataUrl.slice(0, comma).includes(";base64")) return payload.length;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new LogoError("That file could not be read. Try another copy of it."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new LogoError("That file could not be read. Try another copy of it."));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

/** Decodes a raster image without pulling in a dependency. */
async function loadBitmap(
  blob: Blob,
): Promise<{ width: number; height: number; draw: CanvasImageSource }> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, draw: bitmap };
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => {
        resolve(element);
      };
      element.onerror = () => {
        reject(new LogoError("That image could not be decoded. Try a PNG or JPEG."));
      };
      element.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight, draw: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(
  source: { width: number; height: number; draw: CanvasImageSource },
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new LogoError("This browser cannot resize images.");
  context.drawImage(source.draw, 0, 0, width, height);
  return canvas;
}

/**
 * Reads a chosen file into a data URL small enough to store.
 *
 * SVG is kept as vector (it is already small and stays crisp at any size).
 * Rasters are scaled to {@link LOGO_MAX_EDGE} and encoded as PNG; if that is
 * still over target — a photograph rather than a logo — the same pixels are
 * encoded as JPEG at decreasing quality, which trades transparency for fitting.
 */
export async function readLogoFile(file: File): Promise<string> {
  if (!isAcceptedLogoType(file.type)) {
    throw new LogoError("Choose a PNG, JPEG, SVG or WebP image.");
  }

  if (file.type === "image/svg+xml") {
    const dataUrl = await readAsDataUrl(file);
    if (dataUrlBytes(dataUrl) > LOGO_TARGET_BYTES) {
      throw new LogoError("That SVG is too detailed to store. Try exporting a simpler one.");
    }
    return dataUrl;
  }

  const source = await loadBitmap(file);
  const canvas = drawScaled(source, LOGO_MAX_EDGE);
  const png = canvas.toDataURL("image/png");
  if (dataUrlBytes(png) <= LOGO_TARGET_BYTES) return png;

  for (const quality of [0.9, 0.75, 0.6]) {
    const jpeg = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlBytes(jpeg) <= LOGO_TARGET_BYTES) return jpeg;
  }
  // Last resort: a smaller image rather than a refusal, because a logo at 256px
  // still looks right in a header and on a sticker.
  const smaller = drawScaled(source, 256);
  const jpeg = smaller.toDataURL("image/jpeg", 0.8);
  if (dataUrlBytes(jpeg) > LOGO_TARGET_BYTES) {
    throw new LogoError("That image is too detailed. Try a simpler logo, ideally an SVG.");
  }
  return jpeg;
}

/**
 * Turns a pasted logo URL into the same inline form.
 *
 * The fetch happens in the browser, so it only works when the host allows it
 * (CORS). That is a deliberate limit: the API never fetches a URL an
 * administrator typed, which would be a request-forgery surface. When a host
 * refuses, the message says what to do instead.
 */
export async function fetchLogoUrl(url: string): Promise<string> {
  const trimmed = url.trim();
  if (!/^https:\/\/\S+$/i.test(trimmed)) {
    throw new LogoError("Enter an https:// address for the logo.");
  }
  let response: Response;
  try {
    response = await fetch(trimmed, { mode: "cors", credentials: "omit" });
  } catch {
    throw new LogoError(
      "That site would not let the browser read the image. Download it and upload the file instead.",
    );
  }
  if (!response.ok) {
    throw new LogoError(`That address answered ${String(response.status)}.`);
  }
  const blob = await response.blob();
  const type = blob.type.split(";")[0] ?? "";
  if (!isAcceptedLogoType(type)) {
    throw new LogoError("That address is not a PNG, JPEG, SVG or WebP image.");
  }
  return await readLogoFile(new File([blob], "logo", { type }));
}
