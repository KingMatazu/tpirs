/**
 * QR scanning, one module so the rest of the app does not care how a sticker is
 * read.
 *
 * Two decoders, in order of preference:
 *
 * 1. `BarcodeDetector` — native in Chrome on Android, no bundle cost, hardware
 *    accelerated. It is the common case on the phones this is built for.
 * 2. `jsqr` — pure JavaScript, loaded lazily only when the native detector is
 *    missing (iOS Safari, older Android WebViews). It decodes from a canvas
 *    frame, which is slower but works everywhere.
 *
 * Manual entry is not a fallback of last resort: a scratched sticker, a dirty
 * camera or a denied permission all end there, so it is always one tap away.
 */

export type ScannerSupport = "native" | "jsqr" | "none";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export interface ScannerOptions {
  readonly video: HTMLVideoElement;
  readonly onToken: (token: string) => void;
  readonly onError?: (reason: "denied" | "unavailable" | "failed") => void;
  /** How often to look at a frame. 200 ms is ~5 looks a second; enough to feel instant. */
  readonly intervalMs?: number;
}

export interface Scanner {
  stop(): void;
}

/** What this browser can do, so the screen can say so before asking for a camera. */
export function scannerSupport(): ScannerSupport {
  const detector = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  if (typeof detector === "function") return "native";
  // `mediaDevices` is missing on a non-secure origin and in jsdom, so the cast
  // keeps this check meaningful rather than "always defined".
  const media = (globalThis.navigator as { mediaDevices?: MediaDevices }).mediaDevices;
  if (media !== undefined && typeof media.getUserMedia === "function") return "jsqr";
  return "none";
}

/**
 * Strips what a scanner or a person adds around a code: whitespace, and the URL
 * wrapper some sticker designs use (`https://…/v/TOKEN`). The token itself is
 * opaque and case-sensitive, so it is never upper-cased.
 */
export function normaliseToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const fromUrl = /\/v\/([^/?#\s]+)/.exec(trimmed);
  return fromUrl?.[1] ?? trimmed;
}

export async function startScanner(options: ScannerOptions): Promise<Scanner> {
  const { video } = options;
  if (scannerSupport() === "none") {
    options.onError?.("unavailable");
    return { stop: () => undefined };
  }

  let stream: MediaStream;
  try {
    stream = await globalThis.navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch {
    options.onError?.("denied");
    return { stop: () => undefined };
  }

  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  video.muted = true;
  try {
    await video.play();
  } catch {
    // Autoplay can be refused until a gesture; the caller's first tap starts it.
  }

  const detector = createDetector();
  const canvas = detector === undefined ? document.createElement("canvas") : undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastToken = "";
  let lastTokenAt = 0;

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const emit = (raw: string): void => {
    const token = normaliseToken(raw);
    if (token === "") return;
    // The camera sees the same sticker many times a second; report it once.
    const now = Date.now();
    if (token === lastToken && now - lastTokenAt < 2500) return;
    lastToken = token;
    lastTokenAt = now;
    options.onToken(token);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (detector !== undefined) {
        const found = await detector.detect(video);
        const value = found[0]?.rawValue;
        if (value !== undefined) emit(value);
      } else if (canvas !== undefined) {
        const value = await decodeWithCanvas(video, canvas);
        if (value !== undefined) emit(value);
      }
    } catch {
      // A frame that cannot be read is not an error worth stopping for.
    }
    // Scheduled unconditionally: if the scanner was stopped during the await,
    // `finish` already cleared the previous timer and the next tick returns on
    // its first line, so one stray tick costs nothing and leaks nothing.
    timer = setTimeout(() => void tick(), options.intervalMs ?? 200);
  };

  void tick();

  return { stop: finish };
}

function createDetector(): BarcodeDetectorLike | undefined {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  if (typeof ctor !== "function") return undefined;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return undefined;
  }
}

/**
 * `jsqr` is imported here, not at the top of the module, so browsers with a
 * native detector never download it.
 */
async function decodeWithCanvas(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<string | undefined> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return undefined;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return undefined;
  context.drawImage(video, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const { default: jsQR } = await import("jsqr");
  const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  return result?.data;
}
