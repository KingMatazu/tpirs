import { useEffect, type ReactElement } from "react";
import { useSession } from "./session.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";

/**
 * The officer app shell. No router: an officer is either signing in, scanning, or
 * looking at a result, and a back button that can reach a half-finished screen
 * during a scan is a bug, not a feature.
 */
export function App(): ReactElement {
  const status = useSession((state) => state.status);

  useEffect(() => {
    void useSession.getState().initialize();
  }, []);

  if (status === "unknown") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-base text-slate-600">Starting…</p>
      </main>
    );
  }

  return status === "authenticated" ? <HomeScreen /> : <LoginScreen />;
}
