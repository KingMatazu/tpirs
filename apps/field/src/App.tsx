import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useSession } from "./session.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { DisputeScreen } from "./screens/DisputeScreen.js";
import { ResultScreen } from "./screens/ResultScreen.js";
import { ScanScreen } from "./screens/ScanScreen.js";
import { resolveScanOffline } from "./lib/scan.js";
import { recordScan } from "./lib/record.js";
import {
  viewFromQueueFull,
  viewFromQueued,
  viewFromRejected,
  viewFromServer,
} from "./lib/scan-result.js";
import type { ScanView } from "./lib/scan-result.js";

/** The vehicle a dispute is about: the resolved short code, or what was typed. */
function disputeTarget(view: ScanView): string | undefined {
  return view.shortCode ?? view.reference;
}

type Screen =
  | { readonly name: "home" }
  | { readonly name: "scan" }
  | { readonly name: "result"; readonly view: ScanView }
  | { readonly name: "dispute"; readonly view: ScanView };

/**
 * The officer app shell. No router: an officer is either signing in, scanning, or
 * looking at one result, and a back stack that can reach a half-finished scan is
 * a bug rather than a feature.
 */
export function App(): ReactElement {
  const status = useSession((state) => state.status);
  const config = useSession((state) => state.config);
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  useEffect(() => {
    void useSession.getState().initialize();
  }, []);

  const onScanned = useCallback(
    async (input: { token?: string; reference?: string }) => {
      // The id is generated once, here, and travels with the scan through the
      // queue: the server deduplicates on it, so a retry cannot count twice.
      const clientScanId = globalThis.crypto.randomUUID();
      const scannedAt = new Date().toISOString();

      const offline = await resolveScanOffline(input);
      if (offline.kind === "unreadable") {
        // Nothing to record: the sticker is not ours, so posting it would only
        // produce a 404 (or queue a scan that can never succeed).
        setScreen({ name: "result", view: viewFromQueued(offline, input.reference) });
        return;
      }

      const attempt = {
        clientScanId,
        scannedAt,
        source: input.token === undefined ? ("manual" as const) : ("qr" as const),
        ...(input.token === undefined ? {} : { token: input.token }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        // What the cache said, so the ledger's answer can be compared to it.
        observed: offline.kind,
        ...(config === undefined ? {} : { maxQueueItems: config.field.maxQueueItems }),
      };

      const outcome = await recordScan(attempt);
      switch (outcome.status) {
        case "recorded":
          setScreen({ name: "result", view: viewFromServer(outcome.result, offline.kind) });
          return;
        case "rejected":
          setScreen({ name: "result", view: viewFromRejected(offline, input.reference) });
          return;
        case "queue_full":
          setScreen({ name: "result", view: viewFromQueueFull(offline, input.reference) });
          return;
        case "queued":
          setScreen({ name: "result", view: viewFromQueued(offline, input.reference) });
          return;
      }
    },
    [config],
  );

  if (status === "unknown") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-base text-slate-600">Starting…</p>
      </main>
    );
  }

  if (status !== "authenticated") return <LoginScreen />;

  switch (screen.name) {
    case "scan":
      return (
        <ScanScreen
          onBack={() => {
            setScreen({ name: "home" });
          }}
          onScanned={(input) => {
            void onScanned(input);
          }}
        />
      );
    case "result":
      return (
        <ResultScreen
          view={screen.view}
          smsKeyword={config?.channels.smsKeyword}
          smsSenderId={config?.branding.smsSenderId}
          onScanAgain={() => {
            setScreen({ name: "scan" });
          }}
          onBack={() => {
            setScreen({ name: "home" });
          }}
          {...(config?.featureFlags.disputes === true && disputeTarget(screen.view) !== undefined
            ? {
                onDispute: () => {
                  setScreen({ name: "dispute", view: screen.view });
                },
              }
            : {})}
        />
      );
    case "dispute":
      return (
        <DisputeScreen
          context={{
            ...(disputeTarget(screen.view) === undefined
              ? {}
              : { reference: disputeTarget(screen.view) ?? "" }),
            ...(screen.view.shortCode === undefined ? {} : { shortCode: screen.view.shortCode }),
          }}
          reasons={config?.field.disputeReasons ?? []}
          {...(config === undefined ? {} : { maxQueueItems: config.field.maxQueueItems })}
          onBack={() => {
            setScreen({ name: "result", view: screen.view });
          }}
          onDone={() => {
            setScreen({ name: "home" });
          }}
        />
      );
    case "home":
      return (
        <HomeScreen
          onScan={() => {
            setScreen({ name: "scan" });
          }}
        />
      );
  }
}
