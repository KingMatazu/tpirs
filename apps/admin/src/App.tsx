import { useEffect, type ReactElement } from "react";
import { useRoute } from "./lib/router.js";
import { useSession } from "./session.js";
import { Layout } from "./pages/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ConfigViewerPage } from "./pages/ConfigViewerPage.js";
import { ChannelsPage } from "./pages/ChannelsPage.js";
import { UssdSimulatorPage } from "./pages/UssdSimulatorPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { CollectorsPage } from "./pages/CollectorsPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";

const FALLBACK_ROUTE = "/registry";

export function App(): ReactElement {
  const sessionStatus = useSession((state) => state.status);
  const initialize = useSession((state) => () => state.initialize());
  const route = useRoute();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (sessionStatus === "unknown") {
    return <p className="min-h-screen p-8 text-sm text-slate-500">Checking session…</p>;
  }
  if (sessionStatus === "anonymous") {
    return <LoginPage />;
  }

  const page = pageFor(route === "/" ? FALLBACK_ROUTE : route);
  return <Layout>{page}</Layout>;
}

function pageFor(route: string): ReactElement {
  switch (route) {
    case "/registry":
      return <PlaceholderPage title="Asset registry" step="7" />;
    case "/payments":
      return <PlaceholderPage title="Payments" step="8" />;
    case "/collectors":
      return <CollectorsPage />;
    case "/channels":
      return <ChannelsPage />;
    case "/ussd":
      return <UssdSimulatorPage />;
    case "/config":
      return <ConfigViewerPage />;
    case "/audit":
      return <AuditPage />;
    default:
      return <PlaceholderPage title="Asset registry" step="7" />;
  }
}
