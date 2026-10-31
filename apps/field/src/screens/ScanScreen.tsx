import { useEffect, useRef, useState, type ReactElement } from "react";
import { copy } from "../copy.js";
import { Banner, PrimaryButton, Screen, inputClass } from "../components/ui.js";
import { scannerSupport, startScanner } from "../scanner/index.js";

/**
 * Scan screen: the camera, or a typed short code / plate.
 *
 * The camera is started on demand (not on mount) so the officer's first tap is
 * the gesture browsers require, and so a permission prompt never appears while
 * they are reading a result. Manual entry is a tab, not a hidden fallback.
 */
export function ScanScreen(
  props: Readonly<{
    onBack: () => void;
    onScanned: (input: { token?: string; reference?: string }) => void;
  }>,
): ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<"camera" | "manual">(
    scannerSupport() === "none" ? "manual" : "camera",
  );
  const [cameraError, setCameraError] = useState<string | undefined>(undefined);
  const [reference, setReference] = useState("");
  const [starting, setStarting] = useState(false);
  const stopRef = useRef<(() => void) | undefined>(undefined);
  // The callback changes identity on every render of the shell; holding it in a
  // ref keeps the camera from restarting whenever the screen re-renders.
  const onScannedRef = useRef(props.onScanned);
  onScannedRef.current = props.onScanned;

  useEffect(() => {
    if (mode !== "camera") return undefined;
    const video = videoRef.current;
    if (video === null) return undefined;

    let cancelled = false;
    setStarting(true);
    void startScanner({
      video,
      onToken: (token) => {
        stopRef.current?.();
        onScannedRef.current({ token });
      },
      onError: (reason) => {
        if (cancelled) return;
        setCameraError(reason === "denied" ? copy.scan.cameraDenied : copy.scan.cameraUnavailable);
        setMode("manual");
      },
    })
      .then((scanner) => {
        if (cancelled) {
          scanner.stop();
          return;
        }
        stopRef.current = () => {
          scanner.stop();
        };
      })
      .catch(() => {
        if (!cancelled) setCameraError(copy.scan.cameraUnavailable);
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = undefined;
    };
  }, [mode]);

  return (
    <Screen title={copy.scan.title} onBack={props.onBack}>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("camera");
            setCameraError(undefined);
          }}
          className={`min-h-12 flex-1 rounded-xl text-base font-semibold ${
            mode === "camera" ? "bg-slate-900 text-white" : "border-2 border-slate-400 bg-white"
          }`}
        >
          {copy.scan.cameraTab}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("manual");
            stopRef.current?.();
          }}
          className={`min-h-12 flex-1 rounded-xl text-base font-semibold ${
            mode === "manual" ? "bg-slate-900 text-white" : "border-2 border-slate-400 bg-white"
          }`}
        >
          {copy.scan.manualTab}
        </button>
      </div>

      {cameraError === undefined ? null : <Banner tone="warning">{cameraError}</Banner>}

      {mode === "camera" ? (
        <>
          <div className="relative overflow-hidden rounded-xl bg-slate-900">
            <video
              ref={videoRef}
              className="aspect-[3/4] w-full object-cover"
              playsInline
              muted
              aria-label={copy.scan.cameraLabel}
            />
            <div className="pointer-events-none absolute inset-6 rounded-xl border-4 border-white/70" />
          </div>
          <p className="text-center text-base text-slate-700">
            {starting ? copy.scan.starting : copy.scan.hint}
          </p>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (reference.trim() === "") return;
            props.onScanned({ reference: reference.trim() });
          }}
        >
          <label className="block">
            <span className="mb-1 block text-base font-medium text-slate-800">
              {copy.scan.manualLabel}
            </span>
            <input
              className={inputClass}
              value={reference}
              onChange={(event) => {
                setReference(event.currentTarget.value);
              }}
              placeholder="B000123 or MTZ56AA"
              autoCapitalize="characters"
              autoCorrect="off"
              enterKeyHint="search"
            />
          </label>
          <PrimaryButton type="submit" disabled={reference.trim() === ""}>
            {copy.scan.manualSubmit}
          </PrimaryButton>
        </form>
      )}
    </Screen>
  );
}
