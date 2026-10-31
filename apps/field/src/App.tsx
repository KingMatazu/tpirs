import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useSession } from "./session.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { ResultScreen } from "./screens/ResultScreen.js";
import { ScanScreen } from "./screens/ScanScreen.js";
import { resolveScanOffline } from "./lib/scan.js";
import type { ScanOutcome } from "./lib/scan.js";

type Screen =
  | { readonly name: "home" }
  | { readonly name: "scan" }
  | { readonly name: "result"; readonly outcome: ScanOutcome };

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

  const onScanned = useCallback(async (input: { token?: string; reference?: string }) => {
    const outcome = await resolveScanOffline(input);
    setScreen({ name: "result", outcome });
  }, []);

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
          outcome={screen.outcome}
          smsKeyword={config?.channels.smsKeyword}
          smsSenderId={config?.branding.smsSenderId}
          onScanAgain={() => {
            setScreen({ name: "scan" });
          }}
          onBack={() => {
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
