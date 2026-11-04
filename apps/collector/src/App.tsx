import { useEffect, useState, type ReactElement } from "react";
import { useSession } from "./session.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { SetPasswordScreen } from "./screens/SetPasswordScreen.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { FindScreen, type FoundAsset } from "./screens/FindScreen.js";
import { ConfirmScreen } from "./screens/ConfirmScreen.js";
import { DoneScreen } from "./screens/DoneScreen.js";
import { DepositScreen } from "./screens/DepositScreen.js";
import { ProfileScreen } from "./screens/ProfileScreen.js";

type Screen =
  | { readonly name: "home" }
  | { readonly name: "find" }
  | { readonly name: "confirm"; readonly asset: FoundAsset }
  | { readonly name: "done"; readonly receiptNumber: string; readonly replayed: boolean }
  | { readonly name: "deposit" }
  | { readonly name: "profile" };

/**
 * The collector flow: home → find → confirm → done, with deposit reachable from
 * home and from a blocked confirm. One screen at a time, no navigation stack: a
 * collector mid-queue should never end up two levels deep in a menu.
 *
 * Registering a vehicle is deliberately not here. A collector takes cash; adding
 * a driver to the register is a supervisory act (a zone supervisor or a system
 * admin), and the API refuses `POST /v1/assets` without `asset:create`.
 */
export function App(): ReactElement {
  const status = useSession((state) => state.status);
  const mustChangeCredentials = useSession((state) => state.user?.mustChangeCredentials === true);
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  useEffect(() => {
    void useSession.getState().initialize();
  }, []);

  if (status === "unknown") {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Checking session…
      </main>
    );
  }
  if (status === "anonymous") return <LoginScreen />;

  // The server refuses every other route while a temporary password is in place,
  // so the collector must choose one before the cash flow opens.
  if (mustChangeCredentials) return <SetPasswordScreen />;

  const goHome = (): void => {
    setScreen({ name: "home" });
  };

  switch (screen.name) {
    case "home":
      return (
        <HomeScreen
          onCollect={() => {
            setScreen({ name: "find" });
          }}
          onDeposit={() => {
            setScreen({ name: "deposit" });
          }}
          onProfile={() => {
            setScreen({ name: "profile" });
          }}
        />
      );
    case "find":
      return (
        <FindScreen
          onBack={goHome}
          onFound={(asset) => {
            setScreen({ name: "confirm", asset });
          }}
        />
      );
    case "confirm":
      return (
        <ConfirmScreen
          asset={screen.asset}
          onBack={() => {
            setScreen({ name: "find" });
          }}
          onDeposit={() => {
            setScreen({ name: "deposit" });
          }}
          onDone={(receipt) => {
            setScreen({
              name: "done",
              receiptNumber: receipt.receiptNumber,
              replayed: receipt.replayed,
            });
          }}
        />
      );
    case "done":
      return (
        <DoneScreen
          receiptNumber={screen.receiptNumber}
          replayed={screen.replayed}
          onNext={() => {
            setScreen({ name: "find" });
          }}
        />
      );
    case "deposit":
      return <DepositScreen onBack={goHome} />;
    case "profile":
      return <ProfileScreen onBack={goHome} />;
  }
}
